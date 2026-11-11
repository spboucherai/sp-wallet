/**
 * Accounts of the Futures area: venue status, paper accounts (create, choose, reset, edit the risk limits), a read-only look
 * at any public address on a venue, and the honest state of live trading (off, with what it will require). No control here
 * can send a real order: there is no such route.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Field, H, Icon, inputCls, Notice, short, Skeleton } from '../ui';
import { dapi, paperAllowed } from './api';
import { ageText, DataTable, PaperTag, Pnl, Row, Sheet, SideTag, Stat, VENUE_NAME, VenueBadge, type Col } from './bits';
import { fmt, parseInput, priceDp, usd } from './dec';
import type { DerivAccount, Position, RiskPolicy, VenueId, VenueInfo, Watch } from './types';

type LimitKey = 'maxLeverage' | 'maxOrderNotional' | 'maxPositionNotional' | 'maxGrossExposure' | 'minFreeCollateral' | 'maxDailyLoss' | 'maxTotalLoss' | 'minLiquidationDistanceBps' | 'maxDeviationBps' | 'maxMarkIndexBps' | 'maxDataAgeMs' | 'maxOrdersPerMinute' | 'maxOrdersPerDay';
const LIMITS: { k: LimitKey; unit: string; int?: boolean; advanced?: boolean }[] = [
  { k: 'maxLeverage', unit: '×' }, { k: 'maxOrderNotional', unit: 'USD' }, { k: 'maxPositionNotional', unit: 'USD' }, { k: 'maxGrossExposure', unit: 'USD' },
  { k: 'maxDailyLoss', unit: 'USD' }, { k: 'maxTotalLoss', unit: 'USD' }, { k: 'minFreeCollateral', unit: 'USD' }, { k: 'minLiquidationDistanceBps', unit: 'pb' },
  { k: 'maxDeviationBps', unit: 'pb', advanced: true }, { k: 'maxMarkIndexBps', unit: 'pb', advanced: true }, { k: 'maxDataAgeMs', unit: 'ms', int: true, advanced: true },
  { k: 'maxOrdersPerMinute', unit: '/ min', int: true, advanced: true }, { k: 'maxOrdersPerDay', unit: '/ j', int: true, advanced: true },
];
type Limits = Record<LimitKey, string>;
/** cautious defaults for a simulated account of about 10 000 USDC; every one is explained under its field */
export const DEFAULT_LIMITS: Limits = { maxLeverage: '5', maxOrderNotional: '25000', maxPositionNotional: '25000', maxGrossExposure: '50000', minFreeCollateral: '0', maxDailyLoss: '500', maxTotalLoss: '2000',
  minLiquidationDistanceBps: '500', maxDeviationBps: '500', maxMarkIndexBps: '200', maxDataAgeMs: '15000', maxOrdersPerMinute: '20', maxOrdersPerDay: '500' };
const limitsOf = (p: RiskPolicy): Limits => Object.fromEntries(LIMITS.map(({ k }) => [k, String(p[k])])) as Limits;
function toPolicy(l: Limits): Partial<RiskPolicy> | null {
  const out: Record<string, string | number> = {};
  for (const { k, int } of LIMITS) {
    const v = parseInput(l[k]); if (v === null) return null;
    if (int) { if (!/^\d+$/.test(v)) return null; out[k] = Number(v); } else out[k] = v;
  }
  if (!/[1-9]/.test(String(out.maxLeverage))) return null;
  return out as Partial<RiskPolicy>;
}

function LimitsForm({ value, onChange }: { value: Limits; onChange: (l: Limits) => void }) {
  const t = useT(); const [more, setMore] = useState(false);
  return <div className="space-y-3">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{LIMITS.filter((x) => more || !x.advanced).map(({ k, unit }) => <Field key={k} label={t(`fxLim_${k}` as Key)} hint={t(`fxLimHint_${k}` as Key)}>
      <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value.replace(/[^0-9.,]/g, '') })} /><span className="w-10 shrink-0 text-[12.5px] text-mute">{unit === 'pb' ? t('fxBps') : unit === '/ j' ? t('fxPerDay') : unit}</span></div></Field>)}</div>
    <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="min-h-11 text-[13.5px] font-medium text-blue">{t(more ? 'fxLimLess' : 'fxLimMore')}</button>
  </div>;
}

const STATUS: Record<string, [string, string, Key]> = { ok: ['text-emerald bg-emerald/10', 'check', 'fxVenue_ok'], degraded: ['text-warn bg-warn/12', 'warn', 'fxVenue_degraded'], down: ['text-danger bg-danger/10', 'x', 'fxVenue_down'] };
export function VenuePill({ v }: { v: VenueInfo }) {
  const t = useT(); const [cls, ic, key] = STATUS[v.status] ?? STATUS.down!;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${cls}`}><Icon n={ic} className="h-3 w-3" />{t(key)}</span>;
}
/** one line per venue: status in words, and what the venue is limited to here */
export function VenueStrip({ venues, compact }: { venues: VenueInfo[]; compact?: boolean }) {
  const t = useT();
  if (compact) return <ul className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 lg:mx-0 lg:px-0" aria-label={t('fxVenues')} data-testid="venue-strip">{venues.map((v) => <li key={v.id} className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface py-1 pl-2.5 pr-1.5 text-[12px]">
    <span className="font-semibold">{VENUE_NAME[v.id] ?? v.name}</span><VenuePill v={v} />{(v.restriction || !paperAllowed(v)) && <span className="pr-1.5 text-mute">{t(v.id === 'dydx' || v.restriction ? 'fxDataOnly' : 'fxReadOnly')}</span>}</li>)}</ul>;
  return <ul className="divide-y divide-line" data-testid="venue-list">{venues.map((v) => <li key={v.id} className="py-3 first:pt-0 last:pb-0">
    <div className="flex flex-wrap items-center gap-2"><VenueBadge venue={v.id} /><VenuePill v={v} /><span className="text-[12px] text-mute">{v.network}{v.lastOkAt ? ` · ${t('fxLastOk', { age: ageText(Date.now() - v.lastOkAt) })}` : ''}</span></div>
    <p className="mt-1.5 text-[13px] leading-snug">{t(`fxVenueWhat_${v.id}` as Key)}</p>
    {v.restriction && <p className="mt-1 text-[12px] leading-snug text-mute">{t('fxServerSays')} {v.restriction}</p>}</li>)}</ul>;
}

export function AccountsView({ venues, accounts, loading, selected, onSelect }: { venues: VenueInfo[]; accounts: DerivAccount[]; loading: boolean; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const eligible = venues.filter(paperAllowed);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [err, setErr] = useState('');
  const [f, setF] = useState<{ venue: VenueId | ''; label: string; collateral: string; limits: Limits }>({ venue: '', label: '', collateral: '10000', limits: DEFAULT_LIMITS });
  const [edit, setEdit] = useState<{ a: DerivAccount; limits: Limits } | null>(null), [reset, setReset] = useState<DerivAccount | null>(null);
  const venue = f.venue || eligible[0]?.id || '';
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['deriv', 'accounts'] }), qc.invalidateQueries({ queryKey: ['deriv', 'account'] })]);
  const act = async (id: string, fn: () => Promise<unknown>, after?: () => void) => { setBusy(id); setErr(''); try { await fn(); await refresh(); after?.(); } catch (e) { setErr(errText(t, e) || t('fxErrGeneric')); } finally { setBusy(''); } };
  const collateral = parseInput(f.collateral), policy = toPolicy(f.limits);
  const create = () => act('create', async () => { const a = await dapi.createAccount({ venue: venue as VenueId, label: f.label.trim() || t('fxDefaultLabel', { venue: VENUE_NAME[venue as VenueId] }), collateral: collateral!, policy: policy! }); onSelect(a.id); }, () => { setOpen(false); setF({ ...f, label: '' }); });

  return (
    <div className="space-y-4" data-testid="accounts-view">
      <Card><H>{t('fxVenues')}</H>{venues.length ? <VenueStrip venues={venues} /> : <Skeleton h="h-24" />}</Card>

      <Card>
        <H right={<Btn kind="soft" onClick={() => { setOpen(!open); setErr(''); }} disabled={!eligible.length}><Icon n={open ? 'x' : 'plus'} className="h-4 w-4" />{open ? t('cancel') : t('fxNewAccount')}</Btn>}>{t('fxPaperAccounts')}</H>
        <p className="mb-3 text-[13px] leading-snug text-mute">{t('fxPaperIntro')}</p>
        {open && <div className="mb-4 space-y-3 rounded-2xl border border-line p-4" data-testid="account-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('fxVenue')} hint={t('fxVenueHint')}><select className={inputCls} value={venue} onChange={(e) => setF({ ...f, venue: e.target.value as VenueId })}>
              {venues.map((v) => <option key={v.id} value={v.id} disabled={!paperAllowed(v)}>{VENUE_NAME[v.id] ?? v.name}{paperAllowed(v) ? '' : ` — ${t('fxNotAvailable')}`}</option>)}</select></Field>
            <Field label={t('fxLabel')}><input className={inputCls} maxLength={40} value={f.label} placeholder={venue ? t('fxDefaultLabel', { venue: VENUE_NAME[venue as VenueId] }) : ''} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            <Field label={t('fxStartCollateral')} hint={t('fxStartCollateralHint')}><div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" value={f.collateral} onChange={(e) => setF({ ...f, collateral: e.target.value.replace(/[^0-9.,]/g, '') })} /><span className="w-12 shrink-0 text-[12.5px] text-mute">USDC</span></div></Field>
          </div>
          <h3 className="pt-1 text-[14px] font-semibold">{t('fxLimits')}</h3>
          <p className="text-[12.5px] leading-snug text-mute">{t('fxLimitsIntro')}</p>
          <LimitsForm value={f.limits} onChange={(limits) => setF({ ...f, limits })} />
          {err && <Notice tone="danger">{err}</Notice>}
          <Btn full busy={busy === 'create'} disabled={!venue || !collateral || !/[1-9]/.test(collateral) || !policy} onClick={() => void create()}>{t('fxCreatePaper')}</Btn>
        </div>}
        {loading ? <Skeleton h="h-24" /> : accounts.length === 0 ? !open && <p className="py-6 text-center text-[13.5px] text-mute">{t('fxNoAccounts')}</p> :
          <ul className="space-y-3">{accounts.map((a) => { const on = a.id === selected; return <li key={a.id} className={`rounded-2xl border p-4 ${on ? 'border-ink' : 'border-line'}`}>
            <div className="flex flex-wrap items-center gap-2"><span className="text-[15.5px] font-semibold">{a.label}</span><VenueBadge venue={a.venue} />{a.kind === 'paper' ? <PaperTag /> : <span className="rounded-md border border-line px-1.5 py-px text-[10.5px] font-bold uppercase text-mute">{t('fxReadOnly')}</span>}
              {on && <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink"><Icon n="check" className="h-3.5 w-3.5" />{t('fxSelected')}</span>}</div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('fxEquity')}>{usd(a.state.equity, locale)}</Stat><Stat label={t('fxFreeCollateral')}>{usd(a.state.freeCollateral, locale)}</Stat>
              <Stat label={t('fxMarginUsed')}>{usd(a.state.marginUsed, locale)}</Stat><Stat label={t('fxPositions')}>{a.positions.length} · {a.openOrders.length} {t('fxOrdersSmall')}</Stat></div>
            {a.policy.halt && <div className="mt-3"><Notice tone="danger">{t('fxHalted')} <span className="font-mono text-[12px]">{a.policy.halt}</span>
              <button type="button" className="mt-1 block min-h-11 font-semibold underline" disabled={!!busy} onClick={() => void act(`h${a.id}`, () => dapi.setPolicy(a.id, { ...a.policy, halt: null }))}>{t('fxLiftHalt')}</button></Notice></div>}
            {a.kind === 'paper' && <div className="mt-3 flex flex-wrap gap-2">
              {!on && <Btn kind="soft" onClick={() => onSelect(a.id)}>{t('fxUse')}</Btn>}
              <Btn kind="ghost" onClick={() => { setErr(''); setEdit({ a, limits: limitsOf(a.policy) }); }}>{t('fxEditLimits')}</Btn>
              <Btn kind="ghost" onClick={() => { setErr(''); setReset(a); }}>{t('fxReset')}</Btn></div>}
          </li>; })}</ul>}
      </Card>

      <WatchCard venues={venues} />

      <Card className="border-dashed" ><div data-testid="live-card">
        <H right={<span className="inline-flex items-center gap-1 rounded-full bg-elev px-2.5 py-1 text-[12px] font-semibold text-mute"><Icon n="lock" className="h-3.5 w-3.5" />{t('fxLiveOff')}</span>}>{t('fxLive')}</H>
        <p className="text-[13.5px] leading-snug">{t('fxLiveBody')}</p>
        <ul className="mt-3 space-y-2 text-[13.5px] leading-snug">{(['fxLiveReq1', 'fxLiveReq2', 'fxLiveReq3', 'fxLiveReq4'] as const).map((k) => <li key={k} className="flex gap-2.5"><Icon n="key" className="mt-0.5 h-4 w-4 shrink-0 text-mute" /><span>{t(k)}</span></li>)}</ul>
        <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('fxLiveNote')}</p></div>
      </Card>

      {edit && <Sheet wide title={t('fxEditLimitsTitle', { label: edit.a.label })} onClose={() => !busy && setEdit(null)}><div className="space-y-3">
        <p className="text-[12.5px] leading-snug text-mute">{t('fxLimitsIntro')}</p>
        <LimitsForm value={edit.limits} onChange={(limits) => setEdit({ ...edit, limits })} />
        {err && <Notice tone="danger">{err}</Notice>}
        <Btn full busy={busy === 'policy'} disabled={!toPolicy(edit.limits)} onClick={() => void act('policy', () => dapi.setPolicy(edit.a.id, { ...edit.a.policy, ...toPolicy(edit.limits)! }), () => setEdit(null))}>{t('fxSaveLimits')}</Btn></div></Sheet>}
      {reset && <Sheet title={t('fxResetTitle', { label: reset.label })} onClose={() => !busy && setReset(null)}><div className="space-y-3">
        <Notice tone="warn">{t('fxResetBody')}</Notice>{err && <Notice tone="danger">{err}</Notice>}
        <Btn full kind="danger" busy={busy === 'reset'} onClick={() => void act('reset', () => dapi.reset(reset.id), () => setReset(null))}>{t('fxResetConfirm')}</Btn>
        <Btn full kind="ghost" disabled={!!busy} onClick={() => setReset(null)}>{t('cancel')}</Btn></div></Sheet>}
    </div>
  );
}

function WatchCard({ venues }: { venues: VenueInfo[] }) {
  const t = useT(); const { locale } = useContext(I18n);
  const can = venues.filter((v) => v.capabilities?.account && !v.restriction);
  const [venue, setVenue] = useState<VenueId | ''>(''), [addr, setAddr] = useState(''), [asked, setAsked] = useState<{ venue: VenueId; addr: string } | null>(null);
  const v = venue || can[0]?.id || '';
  const q = useQuery({ queryKey: ['deriv', 'watch', asked?.venue, asked?.addr], enabled: !!asked, queryFn: () => dapi.watch(asked!.addr, asked!.venue), refetchInterval: 15_000, retry: 0 });
  const w: Watch | undefined = asked ? q.data : undefined;
  const cols: Col<Position>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (p) => p.instrument.slice(p.instrument.indexOf(':') + 1) }, { id: 's', label: t('fxDirection'), head: true, cell: (p) => <SideTag side={p.side} /> },
    { id: 'size', label: t('fxSize'), num: true, cell: (p) => fmt(p.size, { locale, trim: true }) }, { id: 'e', label: t('fxEntry'), num: true, cell: (p) => fmt(p.entryPrice, { dp: priceDp('0.000001', p.entryPrice), locale }) },
    { id: 'mk', label: t('fxMark'), num: true, cell: (p) => fmt(p.markPrice, { dp: priceDp('0.000001', p.markPrice), locale }) }, { id: 'l', label: t('fxLiqShort'), num: true, cell: (p) => (p.liquidationPrice ? fmt(p.liquidationPrice, { dp: priceDp('0.000001', p.liquidationPrice), locale }) : '—') },
    { id: 'lev', label: t('fxLeverage'), num: true, cell: (p) => `${fmt(p.leverage, { dp: 1, locale, trim: true })}×` }, { id: 'u', label: t('fxUnrealized'), num: true, cell: (p) => <Pnl value={p.unrealizedPnl} locale={locale} /> },
  ];
  return <Card><div data-testid="watch-card">
    <H>{t('fxWatch')}</H>
    <p className="mb-3 text-[13px] leading-snug text-mute">{t('fxWatchIntro')}</p>
    <form className="grid grid-cols-1 gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (v && addr.trim()) setAsked({ venue: v as VenueId, addr: addr.trim() }); }}>
      <Field label={t('fxVenue')}><select className={inputCls} value={v} onChange={(e) => setVenue(e.target.value as VenueId)}>{venues.map((x) => <option key={x.id} value={x.id} disabled={!can.includes(x)}>{VENUE_NAME[x.id] ?? x.name}{can.includes(x) ? '' : ` — ${t('fxNotAvailable')}`}</option>)}</select></Field>
      <Field label={t('fxAddress')}><input className={`${inputCls} font-mono text-[14px]`} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></Field>
      <Btn type="submit" kind="soft" busy={q.isFetching && !q.data} disabled={!v || !addr.trim()}><Icon n="eye" className="h-4 w-4" />{t('fxWatchGo')}</Btn>
    </form>
    {asked && q.isError && <div className="mt-3"><Notice tone="danger">{errText(t, q.error) || t('fxErrGeneric')}</Notice></div>}
    {w && asked && <div className="mt-4 space-y-3" data-testid="watch-result">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]"><VenueBadge venue={asked.venue} /><span className="font-mono">{short(asked.addr)}</span><span className="rounded-md border border-line px-1.5 py-px text-[10.5px] font-bold uppercase text-mute">{t('fxReadOnly')}</span><span className="text-mute">{t('fxSourceVenue')}</span></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label={t('fxEquity')}>{usd(w.state?.equity, locale)}</Stat><Stat label={t('fxFreeCollateral')}>{usd(w.state?.freeCollateral, locale)}</Stat><Stat label={t('fxMarginUsed')}>{usd(w.state?.marginUsed, locale)}</Stat><Stat label={t('fxWithdrawable')}>{usd(w.state?.withdrawable, locale)}</Stat></div>
      <DataTable label={t('fxPositions')} cols={cols} rows={w.positions} rowKey={(p) => p.instrument} empty={t('fxNoPositions')} />
      {w.openOrders.length > 0 && <Row label={t('fxOpenOrders')}>{w.openOrders.length}</Row>}
    </div>}</div>
  </Card>;
}
