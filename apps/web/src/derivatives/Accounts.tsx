/**
 * Accounts of the Futures area: venue status, paper accounts (create, choose, reset, edit the risk limits), a read-only look
 * at any public address on a venue, and controlled live trading (`LiveSection`: venue accounts, authorization, revocation).
 * Nothing in THIS file can send a real order; the live section sends none either without a passkey approval per order.
 * v10: one card per paper account (venue logo, equity as the numeral, its limits in sight); creating an account and editing
 * its limits happen in the shared bottom sheet; resetting an account is a confirmation that only its own buttons close.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Coin, EmptyState, Fact, Field, H, Icon, inputCls, Notice, Section, Sheet, short, Stat as Tile, StatGrid, Tag, VenueIcon } from '../ui';
import { dapi, paperAllowed } from './api';
import { LiveSection } from './LiveAccounts';
import { ageText, DataTable, PaperTag, Pnl, Row, ServerSays, SideTag, VENUE_NAME, VenueBadge, type Col } from './bits';
import { D, dec, fmt, parseInput, pct, priceDp, usd } from './dec';
import { amountInputText, amountLocale } from '../amount';
import type { DerivAccount, Instrument, Position, RiskPolicy, VenueId, VenueInfo, Watch } from './types';

type LimitKey = 'maxLeverage' | 'maxOrderNotional' | 'maxPositionNotional' | 'maxGrossExposure' | 'minFreeCollateral' | 'maxDailyLoss' | 'maxTotalLoss' | 'minLiquidationDistanceBps' | 'maxDeviationBps' | 'maxMarkIndexBps' | 'maxDataAgeMs' | 'maxOrdersPerMinute' | 'maxOrdersPerDay';
const LIMITS: { k: LimitKey; unit: string; int?: boolean; advanced?: boolean }[] = [
  { k: 'maxLeverage', unit: '×' }, { k: 'maxOrderNotional', unit: 'USD' }, { k: 'maxPositionNotional', unit: 'USD' }, { k: 'maxGrossExposure', unit: 'USD' },
  { k: 'maxDailyLoss', unit: 'USD' }, { k: 'maxTotalLoss', unit: 'USD' }, { k: 'minFreeCollateral', unit: 'USD' }, { k: 'minLiquidationDistanceBps', unit: 'pb' },
  { k: 'maxDeviationBps', unit: 'pb', advanced: true }, { k: 'maxMarkIndexBps', unit: 'pb', advanced: true }, { k: 'maxDataAgeMs', unit: 'ms', int: true, advanced: true },
  { k: 'maxOrdersPerMinute', unit: '/ min', int: true, advanced: true }, { k: 'maxOrdersPerDay', unit: '/ j', int: true, advanced: true },
];
type Limits = Record<LimitKey, string>;
/**
 * The backend's own default policy for a collateral C (services/api/src/derivatives/paper.ts, `defaultPolicy`), shown in the form
 * so that what is created is what was read: leverage 3, order ≤ C, position ≤ 2C, exposure ≤ 3C, free collateral ≥ 0.1C,
 * daily loss 0.05C, total loss 0.2C. Every limit is explained under its field and can be changed.
 */
/** v8 hardening: a value the app itself writes in a field uses the screen's decimal separator, so that the one rule of amount.ts reads it back exactly */
const asTyped = (v: string): string => amountInputText(v, amountLocale());
export function defaultLimits(collateral: string | null): Limits {
  const c = dec(collateral) ?? D.from(10000n), times = (k: string) => asTyped(D.str(D.mul(c, D.from(k))));
  return { maxLeverage: '3', maxOrderNotional: times('1'), maxPositionNotional: times('2'), maxGrossExposure: times('3'), minFreeCollateral: times('0.1'), maxDailyLoss: times('0.05'), maxTotalLoss: times('0.2'),
    minLiquidationDistanceBps: '1000', maxDeviationBps: '200', maxMarkIndexBps: '100', maxDataAgeMs: '10000', maxOrdersPerMinute: '10', maxOrdersPerDay: '200' };
}
const defaultAllowed = (venue: string, list: Instrument[]) => [`${venue}:BTC`, `${venue}:ETH`].filter((id) => !list.length || list.some((i) => i.id === id));
const limitsOf = (p: RiskPolicy): Limits => Object.fromEntries(LIMITS.map(({ k }) => [k, asTyped(String(p[k]))])) as Limits;
function toPolicy(l: Limits): Partial<RiskPolicy> | null {
  const out: Record<string, string | number> = {};
  for (const { k, int } of LIMITS) {
    const v = parseInput(l[k]); if (v === null) return null;
    if (int) { if (!/^\d+$/.test(v)) return null; out[k] = Number(v); } else out[k] = v;
  }
  if (!/[1-9]/.test(String(out.maxLeverage))) return null;
  return out as Partial<RiskPolicy>;
}

/** markets the account may trade: anything not listed is refused by the risk engine (`instrument_not_allowed`) */
function AllowedEditor({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: Instrument[] }) {
  const t = useT(); const sym = (id: string) => id.slice(id.indexOf(':') + 1);
  const rest = options.filter((i) => !value.includes(i.id));
  return <div data-testid="allowed-editor">
    <div className="mb-1.5 text-[13px] font-medium text-mute">{t('fxAllowed')}</div>
    <div className="flex flex-wrap items-center gap-2">
      {value.map((id) => <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-elev pl-1.5 text-[14px] font-medium"><Coin sym={options.find((i) => i.id === id)?.base ?? sym(id)} size={24} />{sym(id)}
        <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label={t('fxAllowedRemove', { symbol: sym(id) })} className="press grid h-11 w-9 place-items-center text-mute"><Icon n="x" className="h-3.5 w-3.5" /></button></span>)}
      {rest.length > 0 && <select aria-label={t('fxAllowedAdd')} value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }} className="min-h-11 rounded-full border border-line bg-surface px-3 text-[14px] text-ink">
        <option value="">{t('fxAllowedAdd')}</option>{rest.map((i) => <option key={i.id} value={i.id}>{i.symbol}</option>)}</select>}
    </div>
    <p className="mt-1.5 text-[12px] leading-snug text-mute">{value.length ? t('fxAllowedHint') : <span className="text-danger">{t('fxAllowedNone')}</span>}</p>
  </div>;
}
function LimitsForm({ value, onChange, allowed, onAllowed, options }: { value: Limits; onChange: (l: Limits) => void; allowed: string[]; onAllowed: (v: string[]) => void; options: Instrument[] }) {
  const t = useT(); const [more, setMore] = useState(false);
  return <div className="space-y-4">
    <AllowedEditor value={allowed} onChange={onAllowed} options={options} />
    <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">{LIMITS.filter((x) => more || !x.advanced).map(({ k, unit }) => <Field key={k} label={t(`fxLim_${k}` as Key)} hint={t(`fxLimHint_${k}` as Key)}>
      <div className="relative"><input className={`${inputCls} pr-16`} inputMode="decimal" autoComplete="off" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value.replace(/[^0-9.,]/g, '') })} /><span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] text-mute">{unit === 'pb' ? t('fxBps') : unit === '/ j' ? t('fxPerDay') : unit}</span></div></Field>)}</div>
    <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="min-h-11 text-[14px] font-medium text-blue">{t(more ? 'fxLimLess' : 'fxLimMore')}</button>
  </div>;
}

const STATUS: Record<string, ['ok' | 'warn' | 'danger', string, Key]> = { ok: ['ok', 'check', 'fxVenue_ok'], degraded: ['warn', 'warn', 'fxVenue_degraded'], down: ['danger', 'x', 'fxVenue_down'] };
export function VenuePill({ v }: { v: VenueInfo }) {
  const t = useT(); const [tone, ic, key] = STATUS[v.status] ?? STATUS.down!;
  return <Tag tone={tone} icon={ic}>{t(key)}</Tag>;
}
/** one line per venue: status in words, and what the venue is limited to here */
export function VenueStrip({ venues, compact }: { venues: VenueInfo[]; compact?: boolean }) {
  const t = useT();
  if (compact) return <ul className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 lg:mx-0 lg:px-0" aria-label={t('fxVenues')} data-testid="venue-strip">{venues.map((v) => <li key={v.id} className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-1.5 text-[12.5px]">
    <VenueIcon venue={v.id} size={22} /><span className="font-semibold">{VENUE_NAME[v.id] ?? v.name}</span><VenuePill v={v} />{(v.restriction || !paperAllowed(v)) && <span className="pr-1.5 text-mute">{t(v.id === 'dydx' || v.restriction ? 'fxDataOnly' : 'fxReadOnly')}</span>}</li>)}</ul>;
  return <ul className="divide-y divide-line" data-testid="venue-list">{venues.map((v) => <li key={v.id} className="flex gap-3.5 py-4 first:pt-1 last:pb-0">
    <VenueIcon venue={v.id} size={40} />
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[15.5px] font-semibold">{VENUE_NAME[v.id] ?? v.name}</span><VenuePill v={v} /></div>
      <p className="mt-0.5 text-[12.5px] text-mute">{v.network}{v.lastOkAt ? ` · ${t('fxLastOk', { age: ageText(Date.now() - v.lastOkAt) })}` : ''}</p>
      <p className="mt-1.5 text-[13.5px] leading-snug">{t(`fxVenueWhat_${v.id}` as Key)}</p>
      {v.restriction && <ServerSays text={v.restriction} className="mt-1 text-[12px] leading-snug text-mute" />}</div></li>)}</ul>;
}
const VenueSkeleton = () => <div className="space-y-5" aria-hidden="true">{[0, 1, 2].map((k) => <div key={k} className="flex gap-3.5"><div className="skel h-10 w-10 !rounded-full" /><div className="flex-1 space-y-2 pt-1"><div className="skel h-4 w-36 !rounded-md" /><div className="skel h-3 w-24 !rounded-md" /><div className="skel h-3 w-[85%] !rounded-md" /></div></div>)}</div>;
const AccountSkeleton = () => <div className="card space-y-4 p-5" aria-hidden="true"><div className="flex items-center gap-3"><div className="skel h-10 w-10 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-4 w-40 !rounded-md" /><div className="skel h-3 w-24 !rounded-md" /></div></div>
  <div className="skel h-8 w-44 !rounded-lg" /><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">{[0, 1, 2].map((k) => <div key={k} className="skel h-[62px] !rounded-2xl" />)}</div></div>;

export function AccountsView({ venues, instruments, accounts, loading, selected, onSelect }: { venues: VenueInfo[]; instruments: Instrument[]; accounts: DerivAccount[]; loading: boolean; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const eligible = venues.filter(paperAllowed);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [err, setErr] = useState('');
  // `limits` / `allowed` stay null until the owner edits them: until then they follow the collateral and the venue (the backend's defaults)
  const [f, setF] = useState<{ venue: VenueId | ''; label: string; collateral: string; limits: Limits | null; allowed: string[] | null }>({ venue: '', label: '', collateral: '10000', limits: null, allowed: null });
  const [edit, setEdit] = useState<{ a: DerivAccount; limits: Limits; allowed: string[] } | null>(null), [reset, setReset] = useState<DerivAccount | null>(null);
  const venue = f.venue || eligible[0]?.id || '';
  const ofVenue = (v: string) => instruments.filter((i) => i.venue === v && i.status !== 'halted');
  const limits = f.limits ?? defaultLimits(parseInput(f.collateral)), allowed = f.allowed ?? defaultAllowed(venue, ofVenue(venue));
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['deriv', 'accounts'] }), qc.invalidateQueries({ queryKey: ['deriv', 'account'] })]);
  const act = async (id: string, fn: () => Promise<unknown>, after?: () => void) => { setBusy(id); setErr(''); try { await fn(); await refresh(); after?.(); } catch (e) { setErr(errText(t, e) || t('fxErrGeneric')); } finally { setBusy(''); } };
  const collateral = parseInput(f.collateral), policy = toPolicy(limits);
  const collateralOk = !!collateral && D.gte(D.from(collateral), D.from(10n)) && D.lte(D.from(collateral), D.from(1_000_000_000n));
  const create = () => act('create', async () => { const a = await dapi.createAccount({ venue: venue as VenueId, label: f.label.trim() || t('fxDefaultLabel', { venue: VENUE_NAME[venue as VenueId] }), collateral: collateral!, policy: { ...policy!, allowedInstruments: allowed } }); onSelect(a.id); }, () => { setOpen(false); setF({ ...f, label: '' }); });
  const openForm = () => { setErr(''); setOpen(true); };

  return (
    <div className="space-y-6" data-testid="accounts-view">
      <Card><H>{t('fxVenues')}</H>{venues.length ? <VenueStrip venues={venues} /> : <VenueSkeleton />}</Card>

      <Section title={t('fxPaperAccounts')} right={<button type="button" onClick={openForm} disabled={!eligible.length} className="press -my-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-elev px-4 text-[14px] font-semibold disabled:opacity-45"><Icon n="plus" className="h-4 w-4" />{t('fxNewAccount')}</button>}>
        <p className="mb-3 px-1 text-[13px] leading-snug text-mute">{t('fxPaperIntro')}</p>
        {loading ? <AccountSkeleton /> : accounts.length === 0 ? <EmptyState icon="chart" title={t('dzFxNoAccountTitle')} action={<Btn kind="soft" disabled={!eligible.length} onClick={openForm}><Icon n="plus" className="h-4 w-4" />{t('fxCreateAccount')}</Btn>}>{t('fxNoAccounts')}</EmptyState> :
          <ul className="grid grid-cols-1 gap-4 xl:grid-cols-2">{[...accounts].sort((x, y) => Number(y.id === selected) - Number(x.id === selected)).map((a) => { const on = a.id === selected; return <li key={a.id} className={`card p-5 ${on ? '!border-ink/60' : ''}`} data-selected={on || undefined}>
            <div className="flex items-start gap-3.5"><VenueIcon venue={a.venue} size={44} />
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[16.5px] font-semibold tracking-[-0.01em]">{a.label}</span>{a.kind === 'paper' ? <PaperTag /> : <Tag>{t('fxReadOnly')}</Tag>}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-mute"><span>{VENUE_NAME[a.venue] ?? a.venue}</span>{on && <span className="inline-flex items-center gap-1 font-semibold text-ink"><Icon n="check" className="h-3.5 w-3.5" />{t('fxSelected')}</span>}</div></div></div>
            <div className="mt-4"><div className="text-[12.5px] text-mute">{t('fxEquity')}</div><div className="t-num mt-1 text-[32px]">{usd(a.state.equity, locale)}</div></div>
            <StatGrid cols={3} className="mt-4">
              <Tile label={t('fxFreeCollateral')} value={usd(a.state.freeCollateral, locale)} /><Tile label={t('fxMarginUsed')} value={usd(a.state.marginUsed, locale)} />
              <Tile label={t('fxPositions')} value={a.positions.length} sub={`${a.openOrders.length} ${t('fxOrdersSmall')}`} /></StatGrid>
            {a.kind === 'paper' && <div className="mt-4"><h3 className="t-eyebrow">{t('dzFxLimitsShort')}</h3>
              <dl className="mt-1"><Fact k={t('fxLim_maxLeverage')}>{fmt(a.policy.maxLeverage, { locale, trim: true })}×</Fact><Fact k={t('fxLim_maxOrderNotional')}>{usd(a.policy.maxOrderNotional, locale)}</Fact><Fact k={t('fxLim_maxDailyLoss')}>{usd(a.policy.maxDailyLoss, locale)}</Fact></dl>
              <p className="mt-2 text-[12px] leading-snug text-mute">{t('fxPaperSimpl', { mm: a.settings ? pct(a.settings.maintenanceMarginFraction, 1, locale) : '2 %', taker: a.settings ? pct(a.settings.takerFeeRate, 3, locale) : '—' })} {t('fxAllowedNow', { list: a.policy.allowedInstruments.map((x) => x.slice(x.indexOf(':') + 1)).join(', ') || '—' })}</p></div>}
            {a.policy.halt && <div className="mt-3"><Notice tone="danger">{t('fxHalted')} <span className="font-mono text-[12px]">{a.policy.halt}</span>
              <button type="button" className="mt-1 block min-h-11 font-semibold underline" disabled={!!busy} onClick={() => void act(`h${a.id}`, () => dapi.setPolicy(a.id, { ...a.policy, halt: null }))}>{t('fxLiftHalt')}</button></Notice></div>}
            {a.kind === 'paper' && <div className="mt-4 flex flex-wrap gap-2">
              {!on && <Btn kind="soft" onClick={() => onSelect(a.id)}>{t('fxUse')}</Btn>}
              <Btn kind="ghost" onClick={() => { setErr(''); setEdit({ a, limits: limitsOf(a.policy), allowed: a.policy.allowedInstruments }); }}>{t('fxEditLimits')}</Btn>
              <Btn kind="ghost" onClick={() => { setErr(''); setReset(a); }}>{t('fxReset')}</Btn></div>}
          </li>; })}</ul>}
      </Section>

      <WatchCard venues={venues} />

      <LiveSection selected={selected} onSelect={onSelect} />

      {open && <Sheet wide title={t('fxNewAccount')} sub={t('fxPaperAccounts')} onClose={() => setOpen(false)} busy={busy === 'create'}
        footer={<Btn full busy={busy === 'create'} disabled={!venue || !collateralOk || !policy || !allowed.length} onClick={() => void create()}>{t('fxCreatePaper')}</Btn>}>
        <div className="space-y-4" data-testid="account-form">
          <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
            <Field label={t('fxVenue')} hint={t('fxVenueHint')}><select className={inputCls} value={venue} onChange={(e) => setF({ ...f, venue: e.target.value as VenueId, allowed: null })}>
              {venues.map((v) => <option key={v.id} value={v.id} disabled={!paperAllowed(v)}>{VENUE_NAME[v.id] ?? v.name}{paperAllowed(v) ? '' : ` — ${t('fxNotAvailable')}`}</option>)}</select></Field>
            <Field label={t('fxLabel')}><input className={inputCls} maxLength={40} value={f.label} placeholder={venue ? t('fxDefaultLabel', { venue: VENUE_NAME[venue as VenueId] }) : ''} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            <Field label={t('fxStartCollateral')} hint={collateral && !collateralOk ? <span className="text-danger">{t('fxCollateralRange')}</span> : t('fxStartCollateralHint')}><div className="relative"><input className={`${inputCls} pr-16`} inputMode="decimal" value={f.collateral} onChange={(e) => setF({ ...f, collateral: e.target.value.replace(/[^0-9.,]/g, '') })} /><span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] text-mute">USDC</span></div></Field>
          </div>
          <div className="border-t border-line pt-4"><h3 className="text-[15.5px] font-semibold">{t('fxLimits')}</h3>
            <p className="mt-1 text-[12.5px] leading-snug text-mute">{t('fxLimitsIntro')}</p></div>
          <LimitsForm value={limits} onChange={(l) => setF({ ...f, limits: l })} allowed={allowed} onAllowed={(a) => setF({ ...f, allowed: a })} options={ofVenue(venue)} />
          {f.limits && <button type="button" className="min-h-11 text-[14px] font-medium text-blue" onClick={() => setF({ ...f, limits: null })}>{t('fxLimitsDefault')}</button>}
          {err && <Notice tone="danger">{err}</Notice>}
        </div>
      </Sheet>}
      {edit && <Sheet wide title={t('fxEditLimitsTitle', { label: edit.a.label })} onClose={() => setEdit(null)} busy={busy === 'policy'}
        footer={<Btn full busy={busy === 'policy'} disabled={!toPolicy(edit.limits) || !edit.allowed.length} onClick={() => void act('policy', () => dapi.setPolicy(edit.a.id, { ...edit.a.policy, ...toPolicy(edit.limits)!, allowedInstruments: edit.allowed }), () => setEdit(null))}>{t('fxSaveLimits')}</Btn>}>
        <div className="space-y-4">
          <p className="text-[12.5px] leading-snug text-mute">{t('fxLimitsIntro')}</p>
          <LimitsForm value={edit.limits} onChange={(l) => setEdit({ ...edit, limits: l })} allowed={edit.allowed} onAllowed={(a) => setEdit({ ...edit, allowed: a })} options={ofVenue(edit.a.venue)} />
          {err && <Notice tone="danger">{err}</Notice>}</div></Sheet>}
      {reset && <Sheet dismissable={false} title={t('fxResetTitle', { label: reset.label })} onClose={() => setReset(null)} busy={!!busy}><div className="space-y-3">
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
    <p className="mb-4 text-[13px] leading-snug text-mute">{t('fxWatchIntro')}</p>
    <form className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (v && addr.trim()) setAsked({ venue: v as VenueId, addr: addr.trim() }); }}>
      <Field label={t('fxVenue')}><select className={inputCls} value={v} onChange={(e) => setVenue(e.target.value as VenueId)}>{venues.map((x) => <option key={x.id} value={x.id} disabled={!can.includes(x)}>{VENUE_NAME[x.id] ?? x.name}{can.includes(x) ? '' : ` — ${t('fxNotAvailable')}`}</option>)}</select></Field>
      <Field label={t('fxAddress')}><input className={`${inputCls} font-mono text-[14px]`} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></Field>
      <Btn type="submit" kind="soft" busy={q.isFetching && !q.data} disabled={!v || !addr.trim()}><Icon n="eye" className="h-4 w-4" />{t('fxWatchGo')}</Btn>
    </form>
    {asked && q.isError && <div className="mt-3"><Notice tone="danger">{errText(t, q.error) || t('fxErrGeneric')}</Notice></div>}
    {w && asked && <div className="mt-5 space-y-4 border-t border-line pt-4" data-testid="watch-result">
      <div className="flex flex-wrap items-center gap-2 text-[13px]"><VenueBadge venue={asked.venue} /><span className="font-mono">{short(asked.addr)}</span><Tag icon="eye">{t('fxReadOnly')}</Tag><span className="text-mute">{t('fxSourceVenue')}</span></div>
      <StatGrid cols={4}><Tile label={t('fxEquity')} value={usd(w.state?.equity, locale)} /><Tile label={t('fxFreeCollateral')} value={usd(w.state?.freeCollateral, locale)} /><Tile label={t('fxMarginUsed')} value={usd(w.state?.marginUsed, locale)} /><Tile label={t('fxWithdrawable')} value={usd(w.state?.withdrawable, locale)} /></StatGrid>
      <DataTable label={t('fxPositions')} cols={cols} rows={w.positions} rowKey={(p) => p.instrument} empty={t('fxNoPositions')} emptyIcon="chart" />
      {w.openOrders.length > 0 && <Row label={t('fxOpenOrders')}>{w.openOrders.length}</Row>}
    </div>}</div>
  </Card>;
}
