import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { useNetworks } from '../hooks';
import { issuerOf, LIQUID_HINT } from '../issuer';
import { errText, I18n, useT, type Key } from '../i18n';
import { Addr, AnimatedNumber, Btn, Card, Coin, CopyBtn, EmptyState, Fact, Field, fiat, H, Icon, inputCls, NetDot, Notice, numFmt, PageTitle, Sheet, SkeletonCard, SkeletonRows, Stat, StatGrid, Tag, trimAmt, usdCapital, VenueIcon, when, type Tone } from '../ui';
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
import { EquityCard, FormGroup, Journal, LogoStack, Metric, NetworkChips, UnitInput } from './agentBits'; // v10 design pass

interface AgentV { id: string; name: string; mission: string; state: string; mode: string; network: string; networkName: string; cash: string; universe: string[]; interval: string; capitalUsdc: string; vaultAddress: string;
  risk: { maxExposurePct: number; maxLossPct: number; maxOrderUsd: number; maxDailyUsd: number; maxOrdersPerDay: number; mandateDays: number; slippageBps: number }; strategyVersionId: string | null; mandateId: string | null; stopReason: string | null; lastBar: string | null }
const STATE_TONE: Record<string, [Tone, string]> = { LIVE: ['ok', 'check'], PAPER_TRADING: ['info', 'eye'], AWAITING_APPROVAL: ['warn', 'clock'], PAUSED: ['warn', 'clock'], STOPPED: ['mute', 'stop'], FAILED: ['danger', 'x'] };
/** An agent's state: icon + word, never colour alone. */
export function AgentState({ state }: { state: string }) {
  const t = useT(); const [tone, icon] = STATE_TONE[state] ?? (['mute', 'clock'] as [Tone, string]);
  return <Tag tone={tone} icon={icon}>{t(`ag_${state}` as Key)}</Tag>;
}
// what GET /agents/networks returns: everything is derived from the wallet's token registry, nothing is listed here
interface Repr { asset: string; assetSymbol: string; name: string; kind: 'native' | 'token' | 'wrapped' | 'pegged'; issuer: string | null }
interface Sym { symbol: string; sources: string[]; live: boolean; defaultAsset: string | null; data: Record<string, { status: string; fresh: boolean } | null>; representations: Repr[] }
interface Net { id: string; name: string; native: string; enabled: boolean; cash: { symbol: string; asset: string; name: string }[]; defaultCash: string | null; feeWarning: boolean;
  gas: { reserve: string; perOrder: string; perOrderUsd: number | null; gasPriceGwei: number } | null; symbols: Sym[] }

/** Skeleton of the agents list: shaped like the cards (logos, two lines, the capital line). */
function AgentCardsSkeleton() {
  return <div className="grid gap-3" aria-hidden="true">{[0, 1, 2].map((k) => <div key={k} className="card p-4">
    <div className="flex items-center gap-3.5"><div className="skel h-10 w-16 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-4 w-36 !rounded-md" /><div className="skel h-3 w-24 !rounded-md" /></div></div>
    <div className="mt-3.5 flex items-end justify-between border-t border-line pt-3"><div className="space-y-2"><div className="skel h-3 w-20 !rounded-md" /><div className="skel h-5 w-28 !rounded-md" /></div><div className="skel h-6 w-28 !rounded-full" /></div></div>)}</div>;
}

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
  const num = (k: keyof typeof f, label: string, suffix: string, min: number, max: number) => <Field label={label}>
    <UnitInput value={String(f[k])} unit={suffix} onChange={(v) => setF({ ...f, [k]: Math.max(min, Math.min(max, Number(v.replace(/[^0-9.]/g, '')) || 0)) })} /></Field>;
  const count = q.data?.agents.length ?? 0;
  return (
    <div className="space-y-4">
      <PageTitle right={(open || count > 0) && <Btn kind={open ? 'ghost' : 'primary'} className="!min-h-11 shrink-0 !px-4 !text-[14.5px]" onClick={() => setOpen(!open)}><Icon n={open ? 'x' : 'plus'} className="h-4 w-4" />{open ? t('cancel') : t('agNew')}</Btn>}>{t('agents')}</PageTitle>
      <Notice tone="info">{t('agIntro')}</Notice>
      {/* >>> v6 perp agents: the kind of agent; a perp agent has its own form */}
      {open && <Seg<'spot' | 'perp'> value={kind} onChange={setKind} label={t('paKindLabel')} options={[{ id: 'spot', label: t('paKindSpot') }, { id: 'perp', label: t('paKindPerp') }]} />}
      {open && kind === 'perp' && <Card><PerpAgentForm nav={nav} onCreated={async () => { await qc.invalidateQueries({ queryKey: ['agents'] }); setOpen(false); }} /></Card>}
      {/* <<< v6 perp agents */}
      {open && kind === 'spot' && <Card className="space-y-7">
        <FormGroup title={t('dzAgSecIdentity')}>
          <Field label={t('agName')}><input className={inputCls} maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ETH Trend" /></Field>
          <Field label={t('agMission')}><textarea className={`${inputCls} min-h-[72px] resize-none`} maxLength={400} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
        </FormGroup>

        <FormGroup title={t('dzAgSecNetwork')}>
          <div><div className="mb-2 text-[13px] font-medium text-mute">{t('agNetwork')}</div>
            <NetworkChips label={t('agNetwork')} value={f.network} offNote={t('agNetOff')} onChange={(id) => setF({ ...f, network: id, universe: [], assets: {}, cash: '' })}
              options={(nets.data?.networks ?? [{ id: 'base', name: 'Base', enabled: true } as Net]).map((n) => ({ id: n.id, name: n.name, enabled: n.enabled }))} />
            <p className="mt-2 text-[12.5px] leading-snug text-mute">{t('agNetworkNote')}</p></div>
          {net?.feeWarning && <Notice tone="warn">{t('agFeeWarn', { cost: net.gas?.perOrderUsd != null ? t('agFeeCost', { usd: numFmt(net.gas.perOrderUsd, locale, 2) }) : '' })}</Notice>}
          {net && net.cash.length > 1 && <div><div className="mb-2 text-[13px] font-medium text-mute">{t('agCash')}</div>
            <div role="radiogroup" aria-label={t('agCash')} className="flex flex-wrap gap-2">{net.cash.map((c) => { const on = cash === c.symbol; return (
              <button key={c.symbol} type="button" role="radio" aria-checked={on} onClick={() => setF({ ...f, cash: c.symbol })} className={`press inline-flex min-h-11 items-center gap-2 rounded-[22px] border py-1.5 pl-2 pr-4 text-left text-[14px] font-medium leading-snug ${on ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface text-ink'}`}>
                <Coin sym={c.symbol} net={f.network} size={26} /><span>{c.symbol} <span className="font-normal opacity-75">— {c.name}</span></span></button>); })}</div></div>}
          {cashDef && cashIss && <div className="flex items-start gap-3 rounded-2xl bg-elev/60 p-3.5" data-testid="cash-issuer"><Coin sym={cashDef.symbol} net={f.network} size={28} />
            <p className="min-w-0 text-[13px] leading-snug text-mute">{t('qaCashNote', { net: net!.name, sym: cashDef.symbol, name: cashDef.name, issuer: cashIss.text })}{cashDec !== undefined && cashDec !== 6 ? ` ${t('qaCashDecimals', { dec: cashDec })}` : ''}</p></div>}
        </FormGroup>

        <FormGroup title={t('dzAgSecUniverse')} right={<span className="text-[12.5px] font-semibold text-mute">{f.universe.length} / {maxSym}</span>}>
          <div><div className="mb-2 text-[13px] font-medium text-mute">{t('agUniverse', { cash })}</div>
            {nets.isLoading || !net ? <div className="flex flex-wrap gap-2" aria-hidden="true">{[84, 96, 78, 104, 88, 92].map((w, k) => <div key={k} className="skel h-11 !rounded-full" style={{ width: w }} />)}</div> : <div className="flex flex-wrap gap-2">{net.symbols.map((y) => { const on = f.universe.includes(y.symbol), full = !on && f.universe.length >= maxSym, r = reprOf(y), ready = !!(y.data['1h'] ?? y.data['1d']); return (
              <button key={y.symbol} type="button" role="checkbox" aria-checked={on} disabled={full} title={`${y.representations.map((x) => x.name).join(' / ')} · ${y.sources.join(', ')}`} onClick={() => setF({ ...f, universe: on ? f.universe.filter((x) => x !== y.symbol) : [...f.universe, y.symbol] })}
                className={`press inline-flex min-h-11 items-center gap-2 rounded-full border py-1 pl-2 pr-3.5 text-[14px] font-medium ${on ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface'} ${full ? 'opacity-40' : ''}`}><Coin sym={y.symbol} size={26} />{y.symbol}
                {r && r.assetSymbol !== y.symbol && <span className="text-[12px] font-normal opacity-80">{r.assetSymbol}</span>}
                {r && r.assetSymbol === y.symbol && iss(r) && <span className="text-[11px] font-normal opacity-80">{t(`qaTag_${iss(r)!.kind}` as Key)}</span>}
                {!y.live && <span className={`rounded-full px-1.5 text-[10.5px] font-semibold ${on ? 'bg-onprimary/20' : 'bg-warn/15 text-warn'}`}>{t('agPaperOnly')}</span>}
                {!ready && <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-label={t('agNoData')} title={t('agNoData')} />}
                {on && <Icon n="check" className="h-4 w-4" />}</button>); })}</div>}
            <p className="mt-2.5 text-[12.5px] leading-snug text-mute">{t('agUniverseNote', { max: maxSym, live: nets.data?.maxLiveSymbols ?? 11 })}</p>
            {noData && <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-mute"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />{t('qaNoDataLegend')}</p>}</div>
          {chosen.filter((y) => y.representations.length > 1).map((y) => { const cur = reprOf(y), liquid = LIQUID_HINT[f.network]?.[y.symbol], hint = liquid && y.representations.some((x) => x.assetSymbol === liquid) ? liquid : null, def = y.representations.find((x) => x.asset === y.defaultAsset);
            // every representation is shown with its name and issuer, one tap each: nothing is hidden in a select
            return <fieldset key={y.symbol} data-testid={`repr-${y.symbol}`}><legend className="mb-2 text-[13px] font-medium text-mute">{y.symbol} — {t('agRepr')}</legend>
              <div role="radiogroup" aria-label={`${y.symbol} — ${t('agRepr')}`} className="space-y-2">{y.representations.map((x) => { const on = cur?.asset === x.asset, i = iss(x); return (
                <button key={x.asset} type="button" role="radio" aria-checked={on} onClick={() => setF({ ...f, assets: { ...f.assets, [y.symbol]: x.asset } })} className={`press flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left ${on ? 'border-primary bg-elev/70' : 'border-line'}`}>
                  <Coin sym={x.assetSymbol} net={f.network} size={36} />
                  <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-semibold">{x.assetSymbol} <span className="font-normal text-mute">— {x.name}</span></span>
                    <span className="block text-[12.5px] text-mute">{x.kind === 'native' ? t('agReprNative') : i ? t('agIssuer', { issuer: i.text }) : t('agReprToken')}</span>
                    {(x.asset === y.defaultAsset || x.assetSymbol === hint) && <span className="mt-1.5 flex flex-wrap gap-1.5">{x.asset === y.defaultAsset && <Tag tone="mute">{t('qaReprDefault')}</Tag>}{x.assetSymbol === hint && <Tag tone="ok"><span className="whitespace-normal">{t('qaReprLiquid', { net: net!.name })}</span></Tag>}</span>}</span>
                  <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'}`}>{on && <Icon n="check" className="h-3.5 w-3.5" />}</span></button>); })}</div>
              {hint && def && def.assetSymbol !== hint && <p className="mt-2 text-[12.5px] leading-snug text-mute">{t('qaReprHint', { net: net!.name, liquid: hint, sym: y.symbol, def: def.assetSymbol })}</p>}
              {!cur && <p className="mt-2 text-[12.5px] font-medium text-warn">{t('qaReprChoose', { sym: y.symbol })}</p>}</fieldset>; })}
          {wrapped.length > 0 && <Notice tone="warn">{t('agIssuerNote', { assets: wrapped.join(' ; ') })}</Notice>}
          {paperOnly.length > 0 && <Notice tone="info">{t('agPaperOnlyNote', { assets: paperOnly.join(', ') })}</Notice>}
          {net?.gas && <p className="text-[12.5px] leading-snug text-mute">{t('agGasReserve', { amount: trimAmt(net.gas.reserve, 6), sym: net.native })}{net.gas.perOrderUsd != null && ` ${t('agFeeShare', { usd: numFmt(net.gas.perOrderUsd, locale, net.gas.perOrderUsd < 0.1 ? 4 : 2), pct: numFmt((100 * net.gas.perOrderUsd) / Math.max(1, f.maxOrderUsd), locale, 1) })}`}</p>}
        </FormGroup>

        <FormGroup title={t('dzAgSecCapital')}>
          <Field label={t('agCapital')}><span className="relative block"><input className={`${inputCls} t-num !py-3 pr-16 text-[22px]`} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: sanitizeAmountText(e.target.value) })} /><span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-medium text-mute" data-testid="capital-unit">USD</span></span><AmountProblem text={f.capital} /></Field>
          <div><div className="mb-1.5 text-[13px] font-medium text-mute">{t('agInterval')}</div>
            <Seg<string> value={f.interval} onChange={(v) => setF({ ...f, interval: v })} label={t('agInterval')} options={[{ id: '1h', label: t('qaIv_1h') }, { id: '1d', label: t('qaIv_1d') }]} /></div>
        </FormGroup>

        <FormGroup title={t('dzAgSecRisk')}>
          <div className="grid grid-cols-2 gap-3">
            {num('maxExposurePct', t('agMaxExposure'), '%', 1, 100)}{num('maxLossPct', t('agMaxLoss'), '%', 1, 100)}
            {num('maxOrderUsd', t('agMaxOrder'), 'USD', 1, 100000)}{num('maxDailyUsd', t('agMaxDaily'), 'USD', 1, 1000000)}
          </div>
          <Notice tone="warn">{t('agLossNote')}</Notice>
        </FormGroup>
        {err && <Notice tone="danger">{err}</Notice>}
        <Btn full busy={busy} disabled={f.name.trim().length < 2 || !f.universe.length || f.universe.length > maxSym || undecided || !net?.enabled || !/[1-9]/.test(amountOf(f.capital, locale) ?? '')} onClick={() => void create()}>{t('agCreate')}</Btn>
      </Card>}
      {q.isLoading ? <AgentCardsSkeleton /> : count === 0 ? !open && <EmptyState icon="robot" title={t('agNone')} action={<Btn onClick={() => setOpen(true)}><Icon n="plus" className="h-4 w-4" />{t('agNew')}</Btn>}>{t('dzAgEmpty')}</EmptyState> :
        <div className="grid gap-3">{q.data!.agents.map((a) => { const perp = (a as { kind?: string }).kind === 'perp'; return <button key={a.id} onClick={() => nav({ tab: 'agent', asset: a.id })} className="card row-press block w-full p-4 text-left">
          <span className="flex items-center gap-3.5"><LogoStack syms={a.universe} size={40} />
            <span className="min-w-0 flex-1"><span className="block text-[16.5px] font-semibold leading-snug [overflow-wrap:anywhere]">{a.name}</span><span className="block text-[13px] text-mute">{a.universe.join(' · ')}</span></span>
            <Icon n="chev" className="h-4 w-4 shrink-0 text-mute" /></span>
          <span className="mt-3.5 flex items-end justify-between gap-3 border-t border-line pt-3">
            <span className="min-w-0"><span className="block text-[12px] text-mute">{t('dzAgCapital')}</span><span className="t-num block text-[20px]">{usdCapital(a.capitalUsdc, locale)}</span></span>
            <span className="inline-flex min-w-0 items-center gap-1.5 pb-0.5 text-[13.5px] font-medium text-mute">{perp ? <VenueIcon venue="hyperliquid" size={20} /> : <NetDot net={a.network} size={20} />}<span className="min-w-0 [overflow-wrap:anywhere]">{a.networkName}</span></span></span>
          <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {perp && agentTone(a) !== 'paper' ? <PerpLiveState a={a} /> : <AgentState state={a.state} />}
            {/* a perp agent says what it trades; « simulation » only while it is one (a live agent is named by its mode tag) */}
            {perp && (agentTone(a) === 'paper' ? <Tag tone="info" icon="eye">{t('paListTag')}</Tag> : <Tag tone="mute" icon="bars">{t('paPerps')}</Tag>)}</span></button>; })}</div>}
      {/* v7 research runtime */}<button data-testid="rj-open" onClick={() => nav({ tab: 'research' })} className="card row-press flex w-full items-center gap-3.5 px-4 py-3.5 text-left"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-elev"><Icon n="search" /></span><span className="min-w-0 flex-1 text-[15px] font-semibold">{t('rjTitle')}</span><Icon n="chev" className="h-4 w-4 shrink-0 text-mute" /></button>
    </div>
  );
}

const V_TONE: Record<string, [Tone, string]> = { approved: ['ok', 'check'], live: ['ok', 'bolt'], backtested: ['info', 'chart'], backtesting: ['warn', 'clock'], rejected: ['danger', 'x'], retired: ['mute', 'minus'], draft: ['mute', 'list'] };
/** A strategy version's status: icon + word. */
export function VersionTag({ status }: { status: string }) {
  const t = useT(); const [tone, icon] = V_TONE[status] ?? (['mute', 'list'] as [Tone, string]);
  return <Tag tone={tone} icon={icon}>{t(`agV_${status}` as Key)}</Tag>;
}
const ORDER_TONE: Record<string, [Tone, string]> = { filled: ['ok', 'check'], failed: ['danger', 'x'], skipped: ['mute', 'minus'] };

export function Agent({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => get<any>(`/agents/${id}`), refetchInterval: 15_000 });
  const spot = !!q.data && q.data.kind !== 'perp'; // v6: the vault and the spot library do not exist for a perp agent
  // gas reserve of the agent's network (same query as the creation form)
  const netsQ = useQuery({ queryKey: ['agent-networks'], queryFn: () => get<{ networks: AgentNet[]; feeWarnShare?: number }>('/agents/networks'), staleTime: 60_000, enabled: spot });
  const [sheet, setSheet] = useState<'' | 'fund' | 'withdraw'>('');
  const lib = useQuery({ queryKey: ['strategies'], queryFn: () => get<{ strategies: any[] }>('/strategies'), staleTime: 300_000, enabled: spot });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [mandate, setMandate] = useState<any>(null), [note, setNote] = useState('');
  if (q.isLoading || !q.data) return <div className="space-y-4" aria-hidden="true"><div className="pt-2"><div className="skel h-9 w-56 !rounded-xl" /><div className="skel mt-3 h-4 w-40 !rounded-md" /></div><SkeletonCard lines={2} /><SkeletonCard lines={4} /><SkeletonRows n={3} /></div>;
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
  // v10: presentation only — which band the page wears
  const live = a.state === 'LIVE', paper = a.state === 'PAPER_TRADING', running = live || paper;
  const mode = live ? 'live' : paper ? 'paper' : a.state === 'FAILED' ? 'failed' : 'off';
  const lastLog = (a.log as any[])[0];
  const dayFmt = (ts: number) => new Date(ts).toLocaleDateString(locale === 'fr' ? 'fr-CA' : 'en-CA', { day: 'numeric', month: 'short' });
  return (
    <div className="space-y-4">
      <div><PageTitle onBack={() => nav({ tab: 'agents' })} backLabel={t('back')}>{a.name}</PageTitle>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13.5px] text-mute"><LogoStack syms={a.universe} size={24} max={5} /><span>{a.universe.join(' · ')} · {a.interval}</span><span className="inline-flex items-center gap-1.5"><NetDot net={a.network} size={18} />{a.networkName}</span></div>
        {a.mission && <p className="mt-2.5 text-[14.5px] leading-snug text-mute">{a.mission}</p>}</div>
      {a.stopReason && <Notice tone="warn">{stopText(a.stopReason)}</Notice>}
      {a.state !== 'LIVE' && <div className="space-y-2 empty:hidden" data-testid="agent-warnings">
        {paperOnly.length > 0 && <Notice tone="warn">{t('agPaperOnlyNote', { assets: paperOnly.join(', ') })}</Notice>}
        {syms.length > 11 && <Notice tone="warn">{t('qaWarnTooMany', { n: syms.length })}</Notice>}
        {feeShare !== null && feeShare > (netsQ.data?.feeWarnShare ?? 0.01) && <Notice tone="warn">{t('qaWarnFees', { net: a.networkName, usd: numFmt(anet!.gas!.perOrderUsd!, locale, anet!.gas!.perOrderUsd! < 0.1 ? 4 : 2), pct: numFmt(100 * feeShare, locale, 1), max: a.risk.maxOrderUsd })}</Notice>}</div>}
      {err && !mandate && <Notice tone="danger">{err}</Notice>}{note && <Notice tone="ok">{note}</Notice>}

      <div className="space-y-4">
        {/* 1 — the state: which mode, in words and with an icon; real money is unmistakable */}
        <section className="card overflow-hidden" data-testid="agent-mode" data-mode={mode} aria-label={t('dzAgModeLabel')}>
          <div className={`flex items-center gap-2.5 px-5 py-3 ${live ? 'bg-danger text-[var(--ondanger)]' : paper ? 'border-b border-blue/25 bg-blue/10 text-blue' : 'border-b border-line bg-elev/70 text-mute'}`}>
            <Icon n={live ? 'warn' : paper ? 'eye' : mode === 'failed' ? 'x' : 'stop'} className="h-[18px] w-[18px] shrink-0" />
            <span className="min-w-0 text-[13px] font-extrabold uppercase leading-tight tracking-[0.07em]">{t(live ? 'dzAgModeLive' : paper ? 'dzAgModePaper' : mode === 'failed' ? 'dzAgModeFailed' : 'dzAgModeOff')}</span></div>
          <div className="p-5 pt-4"><div className="flex flex-wrap items-center gap-2"><span className="text-[13px] text-mute">{t('dzAgModeLabel')}</span><AgentState state={a.state} /></div>
            <p className="mt-2 text-[14.5px] leading-snug">{t(live ? 'dzAgModeLiveText' : paper ? 'dzAgModePaperText' : 'dzAgModeOffText')}</p>
            {a.mandateStatus && <p className="mt-2 text-[13px] text-mute">{t('agMandateState')}: {a.mandateStatus.revoked ? t('agM_revoked') : a.mandateStatus.expired ? t('agM_expired') : t('agM_active')} · {t('agOrdersToday')} {a.mandateStatus.today.orders}/{a.mandateStatus.maxOrdersPerDay}</p>}</div>
        </section>

        <AgentChecklist a={a} gas={netsQ.data?.networks.find((n) => n.id === a.network)?.gas ?? null} approved={!!approved} busy={busy}
          onFund={() => setSheet('fund')} onStrategy={() => document.getElementById('qa-strategies')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          onPaper={() => void act('paper', () => post(`/agents/${id}/mode`, { mode: 'PAPER' }))} onLive={() => { document.getElementById('qa-control')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); void prepare(); }} />
      </div>
      {sheet === 'fund' && <FundSheet a={a} gas={netsQ.data?.networks.find((n) => n.id === a.network)?.gas ?? null} nav={nav} onClose={() => { setSheet(''); void qc.invalidateQueries({ queryKey: ['agent', id] }); }} />}
      {sheet === 'withdraw' && <WithdrawSheet a={a} onClose={() => setSheet('')} />}

      {/* 2 — the money: the real vault, then (apart) the simulated book, then the value curve */}
      <div className="space-y-4">
      <Card><H>{t('agVault')}</H>
        <div className="t-display text-[clamp(34px,10.5vw,44px)]"><AnimatedNumber value={vaultUsd} format={(v) => fiat(v, 'USD', locale)} /></div>
        <div className="mt-2 text-[13.5px] text-mute" data-testid="agent-capital">{t('agAllocated')} <span className="font-semibold text-ink">{usdCapital(a.capitalUsdc, locale)}</span></div>
        {a.state === 'PAPER_TRADING' && <div className="mt-3" data-testid="paper-vault-note"><Notice tone="info">{t('qaPaperVaultNote')}</Notice></div>}
        <ul className="mt-3 divide-y divide-line border-t border-line">{(a.vault ?? []).map((x: any) => <li key={x.asset} className="flex items-center gap-3.5 py-3"><Coin sym={x.assetSymbol || x.symbol} net={a.network} size={40} />
          <span className="min-w-0 flex-1"><span className="block text-[15.5px] font-semibold">{x.symbol}</span>{x.role === 'gas' ? <span className="block text-[12.5px] text-mute">{t('agGasRole')}</span> : (x.assetSymbol && x.assetSymbol !== x.symbol) || iss(x) ? <span className="block text-[12.5px] leading-snug text-mute">{t('agHeldAs', { asset: x.name && x.name !== x.assetSymbol ? `${x.assetSymbol} — ${x.name}` : x.assetSymbol })}{iss(x) ? ` · ${t('agIssuer', { issuer: iss(x)!.text })}` : ''}</span> : null}</span>
          <span className="shrink-0 text-right"><span className="block text-[15.5px] font-semibold">{trimAmt(x.display, 8)}</span><span className="block text-[12.5px] text-mute">{x.usd !== null ? fiat(x.usd, 'USD', locale) : ''}</span></span></li>)}</ul>
        <div className="mt-1 rounded-2xl bg-elev/60 p-3.5"><div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium text-mute"><NetDot net={a.network} size={16} />{t('agVaultAddr', { network: a.networkName })}</div><Addr value={a.vaultAddress} /></div>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <Btn kind="soft" full onClick={() => setSheet('fund')}><Icon n="up" className="h-4 w-4 shrink-0" />{fundingInProgress(a.id) ? t('qaFundResume') : t('qaFundOpen')}</Btn>
          <CopyBtn text={a.vaultAddress} full /></div>
        <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('qaFundNote', { cash: a.cash ?? 'USDC', native: (a.vault ?? []).find((x: any) => x.asset === 'native')?.assetSymbol ?? 'ETH', network: a.networkName })}</p>
        {issuers.length > 0 && <div className="mt-3"><Notice tone="warn">{t('agIssuerNote', { assets: issuers.join(' ; ') })}</Notice></div>}
        <ElsewhereFunds a={a} />
      </Card>
      <div className="min-w-0 space-y-4">
      {/* v8 hardening: the paper book, a card of its own — never mixed with the real vault above */}
      {showPaperBook(a) && <PaperBookCard paper={a.paper} />}

      <EquityCard title={t('agEquity')} right={<Tag tone={live ? 'warn' : 'info'} icon={live ? 'bolt' : 'eye'}>{t(live ? 'agLive' : 'agPaper')}</Tag>} points={eq} format={(v) => fiat(v, 'USD', locale)} formatTime={dayFmt} testid="agent-equity" />
      </div></div>

      {/* 3 — what it is doing: strategy in service, last and next bar, last decision; then the strategies and the research */}
      <div className="space-y-4">
      <div className="min-w-0 space-y-4">
      <Card><H right={<AgentState state={a.state} />}>{t('dzAgNow')}</H>
        <StatGrid>
          <div className="col-span-2"><Stat label={t('dzAgStatStrategy')} value={approved ? <>{approved.name} <span className="font-normal text-mute">v{approved.version}</span></> : <span className="text-mute">{t('dzAgStatNone')}</span>} /></div>
          <Stat label={t('agInterval')} value={a.interval === '1h' ? t('qaIv_1h') : a.interval === '1d' ? t('qaIv_1d') : a.interval} />
          <Stat label={t('dzAgStatLastBar')} value={a.lastBar ? when(a.lastBar, locale) : '—'} sub={running ? undefined : t('dzAgStatNotRunning')} />
        </StatGrid>
        <div className="mt-2.5 rounded-2xl bg-elev/60 px-3.5 py-3"><span className="block text-[12px] text-mute">{t('dzAgStatLastDecision')}</span>
          {lastLog ? <><span className="mt-0.5 block text-[15px] font-semibold leading-snug">{logTitle(lastLog.title)}</span><span className="block text-[12.5px] text-mute">{when(lastLog.ts, locale)}</span></> : <span className="mt-0.5 block text-[14.5px] text-mute">{t('agNoLog')}</span>}</div>
      </Card>

      <div id="qa-strategies" className="scroll-mt-20" /><Card><H>{t('agStrategy')}</H>
        {(a.versions as any[]).length === 0 ? <p className="text-[14px] leading-snug text-mute">{t('agNoStrategy')}</p> : <ul className="space-y-3">{(a.versions as any[]).map((v) => <li key={v.id} className={`rounded-2xl border p-4 ${v.id === a.strategyVersionId ? 'border-emerald/35' : 'border-line'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[15.5px] font-semibold">{v.name} <span className="font-normal text-mute">v{v.version}</span></span><VersionTag status={v.status} /></div>
          <div className="mt-1 break-all font-mono text-[11px] text-mute">sha256 {v.code_sha256}</div>
          {v.metrics ? <><dl className="mt-3 rounded-2xl bg-elev/60 px-3.5 py-1">
            <Metric label={t('agRet')} value={pct(metric(v, 'test', 'total_return'))} sub={<>{t('agVs')} {pct(v.benchmarks?.buy_and_hold?.total_return ?? null)}</>} />
            <Metric label="Sharpe" value={num2(metric(v, 'test', 'sharpe'))} sub={<>{t('agVs')} {num2(v.benchmarks?.buy_and_hold?.sharpe ?? null)}</>} />
            <Metric label={t('agDD')} value={pct(metric(v, 'test', 'max_drawdown'))} sub={<>{t('agVs')} {pct(v.benchmarks?.buy_and_hold?.max_drawdown ?? null)}</>} /></dl>
            <p className="mt-2.5 text-[12.5px] leading-snug text-mute">{t('agReportNote', { trials: v.robustness?.trials_tested ?? '?', dsr: typeof v.robustness?.deflated_sharpe === 'number' ? numFmt(v.robustness.deflated_sharpe, locale, 2, 2) : '?', fee: v.config?.fee_bps ?? '?', slip: v.config?.slippage_bps ?? '?' })}</p></>
            : <p className="mt-2 flex items-start gap-2 text-[13px] leading-snug text-mute">{v.status === 'backtesting' && <Icon n="spin" className="mt-0.5 h-4 w-4 shrink-0" />}<span>{v.status === 'backtesting' ? t('agBacktesting') : v.notes ? v.notes : t('agNoReport')}</span></p>}
          {v.status !== 'approved' && v.metrics && a.state !== 'LIVE' && <Btn kind="soft" full className="mt-3" busy={busy === `a${v.id}`} onClick={() => act(`a${v.id}`, () => post(`/agents/${id}/strategies/${v.id}/approve`))}>{t('agApproveVersion')}</Btn>}
        </li>)}</ul>}
        {a.state !== 'LIVE' && (() => { const have = new Set((a.versions as any[]).map((v) => v.code_sha256)), uni = [...(a.universe as string[])].sort().join(), n = (a.universe as string[]).length;
          // a universe-generic strategy fits any agent whose number of assets is within its bounds; a fixed one needs exactly these assets
          const fit = (lib.data?.strategies ?? []).filter((x) => !have.has(x.sha256) && x.meta.interval === a.interval && (x.generic ? n >= x.minSymbols && n <= x.maxSymbols : [...x.meta.universe].sort().join() === uni));
          return <div className="mt-5 border-t border-line pt-4"><div className="t-eyebrow mb-2.5">{t('agLibrary')}</div>
            {lib.isLoading ? <div className="space-y-2" aria-hidden="true"><div className="skel h-[68px] !rounded-2xl" /><div className="skel h-[68px] !rounded-2xl" /></div> : fit.length === 0 ? <p className="text-[13.5px] leading-snug text-mute">{t('agLibNone', { assets: (a.universe as string[]).join(', '), interval: a.interval })}</p> :
              <ul className="divide-y divide-line">{fit.map((x) => <li key={x.sha256} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold"><span>{x.meta.name} <span className="font-normal text-mute">v{x.meta.version}</span></span>{x.generic && <Tag tone="info">{t('agGeneric')}</Tag>}</span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-mute [overflow-wrap:anywhere]">{x.generic ? t('agGenericNote', { n: (a.universe as string[]).join(' · ') }) : x.meta.universe.join(' · ')} · {x.meta.interval} · {Object.entries(x.meta.params).map(([k, v]) => `${k} ${String(v)}`).join(', ')}</span></span>
                <Btn kind="soft" className="shrink-0" busy={busy === `r${x.sha256}`} onClick={() => act(`r${x.sha256}`, () => post(`/agents/${id}/strategies`, { path: x.path.replace(/^strategies\//, '') }))}>{t('agLibTest')}</Btn></li>)}</ul>}
          </div>; })()}
      </Card>
      </div>

      {/* v7 research runtime */}<ResearchPanel agent={a} nav={nav} />
      </div>

      {/* 4 — what it did: orders, then the journal */}
      <div className="space-y-4">
      <Card className="!px-0 !pb-1"><div className="px-5"><H right={(a.orders as any[]).length > 0 && <span className="text-[13px] text-mute">{Math.min(25, (a.orders as any[]).length)}</span>}>{t('agOrders')}</H></div>
        {(a.orders as any[]).length === 0 ? <div className="flex items-center gap-3.5 px-5 pb-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-elev text-mute"><Icon n="swap" /></span><p className="text-[14px] text-mute">{t('agNoOrders')}</p></div> : <ul>{(a.orders as any[]).slice(0, 25).map((o, k) => { const [tone, icon] = ORDER_TONE[o.state] ?? (['mute', 'clock'] as [Tone, string]); return <li key={o.id} className={`flex items-center gap-3 px-5 py-3 ${k ? 'border-t border-line' : ''}`}>
          <span className="flex shrink-0 items-center" aria-hidden="true"><Coin sym={o.from_symbol} size={30} /><span className="-ml-2 rounded-full ring-2 ring-surface"><Coin sym={o.to_symbol} size={30} /></span></span>
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[14.5px] font-semibold">{o.from_symbol} → {o.to_symbol}</span><Tag tone={o.mode === 'LIVE' ? 'warn' : 'info'} icon={o.mode === 'LIVE' ? 'bolt' : 'eye'}>{o.mode === 'LIVE' ? t('agLive') : t('agPaper')}</Tag></span>
            <span className="mt-0.5 block text-[12.5px] leading-snug text-mute">{when(o.ts, locale)}{o.reason ? ` · ${orderReason(o.reason)}` : ''}</span></span>
          <Tag tone={tone} icon={icon}>{t(`agO_${o.state}` as Key)}</Tag></li>; })}</ul>}</Card>

      <Card><H>{t('agLog')}</H>
        <Journal empty={t('agNoLog')} items={(a.log as any[]).map((l, k) => ({ key: String(k), title: logTitle(l.title), time: when(l.ts, locale), body: l.body ? <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String(l.body).slice(0, 600)}</span> : undefined }))} /></Card>
      </div>

      {/* 5 — the controls, last: run, pause, go live, bring the funds back; what ends a mandate is danger-styled */}
      <div id="qa-control" className="scroll-mt-20" /><Card><H>{t('agControl')}</H>
        <div className="grid gap-2.5">
          {approved && ['AWAITING_APPROVAL', 'PAUSED', 'STOPPED', 'CREATED'].includes(a.state) && <Btn kind="soft" full busy={busy === 'paper'} onClick={() => act('paper', () => post(`/agents/${id}/mode`, { mode: 'PAPER' }))}><Icon n="eye" className="h-4 w-4 shrink-0" />{t('agStartPaper')}</Btn>}
          {a.state === 'PAPER_TRADING' && <Btn kind="ghost" full busy={busy === 'pause'} onClick={() => act('pause', () => post(`/agents/${id}/mode`, { mode: 'PAUSED' }))}><Icon n="clock" className="h-4 w-4 shrink-0" />{t('agPause')}</Btn>}
          {approved && a.state !== 'LIVE' && !mandate && <Btn kind="soft" full busy={busy === 'prepare'} onClick={() => void prepare()}><Icon n="key" className="h-4 w-4 shrink-0" />{t('agGoLive')}</Btn>}
          <Btn kind="ghost" full disabled={!(a.vault ?? []).some((x: any) => x.amount !== '0')} onClick={() => setSheet('withdraw')}><Icon n="down" className="h-4 w-4 shrink-0" />{t('agWithdraw')}</Btn>
        </div>
        {!approved && <p className="mt-3 text-[13.5px] leading-snug text-mute">{t('agNeedsStrategy')}</p>}
        {a.state === 'LIVE' && <div className="mt-4 border-t border-line pt-4"><Btn kind="danger" full busy={busy === 'revoke'} onClick={() => act('revoke', () => post(`/agents/${id}/revoke`))}><Icon n="stop" />{t('agRevoke')}</Btn></div>}
      </Card>

      {/* the go-live mandate: an APPROVAL sheet — it closes only through its own buttons, every field in full */}
      {mandate && <Sheet title={t('agMandateTitle')} onClose={() => setMandate(null)} dismissable={false} busy={busy === 'mandate'} testid="agent-mandate"
        footer={<div className="space-y-2.5 pb-1"><Btn full busy={busy === 'mandate'} onClick={() => void approveMandate()}><Icon n="key" />{t('agApproveMandate')}</Btn>
          <Btn full kind="ghost" disabled={busy === 'mandate'} onClick={() => setMandate(null)}>{t('cancel')}</Btn></div>}>
        <div className="space-y-3.5">
          <Notice tone="warn">{t('agMandateWarn')}</Notice>
          <ul className="divide-y divide-line rounded-2xl border border-line px-4">{(mandate.limits as any[]).map((l) => <li key={l.symbol} className="flex items-center gap-3 py-3"><Coin sym={String(l.symbol).split(' ')[0]!} net={a.network} size={30} /><span className="text-[15px] font-semibold">{l.symbol}</span><span className="min-w-0 flex-1 text-right text-[13.5px] leading-snug text-mute [overflow-wrap:anywhere]">{trimAmt(l.maxOrder, 6)} {t('agPerOrder')} · {trimAmt(l.maxDaily, 6)} {t('agPerDay')}</span></li>)}</ul>
          {issuers.length > 0 && <Notice tone="warn">{t('agIssuerNote', { assets: issuers.join(' ; ') })}</Notice>}
          <dl className="receipt rounded-2xl border border-line px-4 py-1.5"><Fact k={t('agMandateNet')}><span className="inline-flex items-center gap-1.5"><NetDot net={a.network} size={18} />{mandate.networkName}</span></Fact>
            {mandate.gasReserve && <Fact k={t('agMandateGas')}>{trimAmt(mandate.gasReserve.required, 6)} {mandate.gasReserve.symbol}</Fact>}
            <Fact k={t('agOrdersDay')}>{mandate.mandate.maxOrdersPerDay}</Fact>
            <Fact k={t('agExpires')}>{when(new Date(mandate.mandate.expiresAt * 1000), locale)}</Fact>
            <Fact k={t('agStrategyHash')} mono><span className="break-all text-[11.5px]">{mandate.mandate.strategySha256}</span></Fact>
            <Fact k={t('fingerprint')} mono><span className="break-all text-[11.5px]">{mandate.hash}</span></Fact></dl>
          {err && <Notice tone="danger">{err}</Notice>}
        </div>
      </Sheet>}
    </div>
  );
}
