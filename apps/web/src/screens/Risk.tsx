// V11 — Risk: the owner's controls of the independent risk engine and of the trading mandates (/api/v1/risk, /api/v1/mandates,
// owner session only). Kill switch and read-only mode (engaging is free, releasing needs the passkey), the limits (a form; a
// loosening needs the passkey), exposure per asset and per venue, leverage, collateral, distances to liquidation, the alerts
// and the last decisions of the engine, and the mandates: a creation form, and an approval sheet that shows every field, who
// enforces each of them and the full mandate hash — before the passkey prompts.
// Every figure comes from the server; nothing is computed or assumed here. The forms live in ../risk/.
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApprovalOutcomePanel, inDoubt, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says

import { renderAlert } from '../../../../packages/core/src/alert-catalog';
import type { AlertItem } from '../alerts';
import { get, post, type ApiError } from '../api';
import { I18n, useT, type Key } from '../i18n';
import { localizeAlertParams } from '../reasonTexts';
import { LimitsEditor, limitText, LIMIT_GROUPS, type LimitsView } from '../risk/limits';
import { EnforcementTable, MandateApprovalSheet, MandateFields, MandateForm, type ApprovalSheet, type Enforcement } from '../risk/mandate';
import { Btn, Card, EmptyState, ErrorState, Fact, Field, Fold, Icon, inputCls, Notice, PageTitle, Section, Seg, SkeletonCard, Stat, StatGrid, Tag, when } from '../ui';

interface Switch { on: boolean; at: number | null; by: { kind: string; id: string } | null; reason: string | null }
interface Exposure { book: string; error?: string; equity?: string; peakEquity?: string; grossExposure?: string; leverage?: string | null; errors?: string[];
  byAsset?: { asset: string; long: string; short: string; net: string }[]; byVenue?: { venue: string; gross: string }[];
  collateral?: { venue: string; accountId: string; equity: string; collateral: string; freeCollateral: string; marginUsed: string; shareBps: string | null }[];
  positions?: { venue: string; accountId: string; instrument: string; side: string; size: string; markPrice: string; notional: string; leverage: string; liquidationPrice: string | null; liquidationDistanceBps: string | null; unrealizedPnl: string }[] }
interface Decision { id: number; at: number; kind: string; preview: boolean; principal: { kind: string; id: string }; mode: string; venue: string; instrument: string | null; decision: 'allow' | 'deny'; reducing: boolean; failing: { id: string; observed: string | null; limit: string | null; detail: string }[] }
interface State { switches: { killSwitch: Switch; readOnly: Switch }; limits: { paper: LimitsView; live: LimitsView }; exposure: { paper: Exposure; live: Exposure; liveTestnet: Exposure }; decisions: Decision[]; locks: { id: string; on: boolean; why: string }[] }
interface Mandate { id: string; principal: { kind: string; id: string }; mode: 'paper' | 'live'; state: string; phase: string; hash: string; label: string; mandate: Record<string, unknown>; enforcement: Enforcement[];
  usage: { ordersAccepted: number; ordersRejected: number; ordersToday: number; openOrders: number; notionalTotal: string }; stop: { code: string; detail: string } | null; notAfter: number;
  integrity?: { ok: boolean; reason: string | null } | null; approval?: { hash: string; tradingMandateHash: string; signerMandateHash: string; approvedAt: number } | null }

// V11 market making: the quoting mandates (a chunk of its own, shared with the agent page; the form and the approval sheet live there)
const QuotingMandatesBlock = lazy(() => import('./mmPanel').then((m) => ({ default: m.QuotingMandatesBlock })));
const BOOKS = ['paper', 'live', 'liveTestnet'] as const;
const num = (x: string | null | undefined, d = 2): string => { if (x === null || x === undefined) return '—'; const n = Number(x); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : x; };
const pct = (bps: string | null | undefined): string => (bps === null || bps === undefined ? '—' : `${num(String(Number(bps) / 100), 1)} %`);

/** the sentence of an error of the risk routes; a cancelled passkey prompt says nothing */
function useErr() {
  const t = useT();
  return (e: unknown): string => { const x = e as ApiError & { name?: string }; if (x?.name === 'NotAllowedError') return ''; return t('rkErr', { code: x?.code ?? 'error', message: x?.message ?? '' }); };
}
const Names = ({ fields }: { fields: string[] }) => { const t = useT(); return <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px]">{fields.map((f) => <li key={f} data-field={f}>{t(`rkL_${f}` as Key)} <span className="font-mono text-[11.5px] text-mute">{f}</span></li>)}</ul>; };

export function Risk({ onBack, mandate: wanted }: { onBack: () => void; /** v11 interface: `/risk?mandate=<id>` — the mandate to scroll to and open */ mandate?: string }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient(); const err = useErr();
  const q = useQuery({ queryKey: ['risk', 'state'], queryFn: () => get<State>('/risk/state'), refetchInterval: 20_000 });
  const mq = useQuery({ queryKey: ['risk', 'mandates'], queryFn: () => get<{ mandates: Mandate[] }>('/mandates'), refetchInterval: 30_000 });
  const aq = useQuery({ queryKey: ['risk', 'alerts'], queryFn: () => get<{ items: AlertItem[] }>('/alerts?group=security&limit=50'), refetchInterval: 30_000 });
  const [busy, setBusy] = useState(''); const [fail, setFail] = useState(''); const [reason, setReason] = useState('');
  const [book, setBook] = useState<(typeof BOOKS)[number]>('live'); const [mode, setMode] = useState<'paper' | 'live'>('live');
  const [editing, setEditing] = useState(false); const [sheet, setSheet] = useState<ApprovalSheet | null>(null); const [creating, setCreating] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['risk'] }); }; const ap = useApprovalOutcome<State>();
  // v11 interface — `/risk?mandate=<id>`: once the mandates and the page are there, that mandate's card is scrolled into view and focused, and its
  // details are open (below). Nothing is approved from a link: the approval sheet opens on a tap only.
  const wantedFound = !!wanted && (mq.data?.mandates ?? []).some((m) => m.id === wanted), pageReady = !!q.data;
  useEffect(() => { if (!wantedFound || !pageReady) return; const el = document.querySelector<HTMLElement>(`[data-mandate-card="${CSS.escape(wanted!)}"]`); if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); el.focus({ preventScroll: true }); }, [wanted, wantedFound, pageReady]);
  const run = async (id: string, fn: () => Promise<unknown>): Promise<boolean> => { setBusy(id); setFail(''); try { await fn(); refresh(); return true; } catch (e) { if (!inDoubt(e)) setFail(err(e)); return false; } finally { setBusy(''); } };

  /** releasing a switch: the server prepares the intent, the passkey signs its hash */
  const release = (kind: 'kill-switch' | 'read-only') => run(kind, async () => {
    const p = await post(`/risk/${kind}/release/prepare`, {});
    const body = p.needed ? { assertion: await startAuthentication({ optionsJSON: p.options }) } : {};
    // NEXT W1: a lost answer is settled by the risk state read from the server (is the switch still on?)
    await ap.send<unknown>({ submit: () => post(`/risk/${kind}/release`, body), read: () => get<State>('/risk/state'), applied: (s) => !s.switches[kind === 'kill-switch' ? 'killSwitch' : 'readOnly'].on, late: refresh });
  });
  const openApproval = (id: string) => run(`prep-${id}`, async () => { setSheet(await post(`/mandates/${id}/approve/prepare`, { locale })); });

  if (q.isLoading) return <div className="space-y-4"><PageTitle onBack={onBack} backLabel={t('settings')}>{t('rkTitle')}</PageTitle><SkeletonCard lines={4} /><SkeletonCard lines={3} /></div>;
  if (q.isError || !q.data) return <div className="space-y-4"><PageTitle onBack={onBack} backLabel={t('settings')}>{t('rkTitle')}</PageTitle><ErrorState title={t('rkLoadError')} onRetry={() => void q.refetch()} /></div>;
  const d = q.data, ks = d.switches.killSwitch, ro = d.switches.readOnly, x = d.exposure[book], lim = d.limits[mode], live = d.limits.live;
  const who = (s: Switch): ReactNode => s.on ? <span className="text-[12.5px] text-mute">{s.by ? `${s.by.kind}:${s.by.id}` : ''}{s.at ? ` · ${when(new Date(s.at), locale)}` : ''}{s.reason ? ` · ${s.reason}` : ''}</span> : null;
  const mandates = mq.data?.mandates ?? [];
  const riskAlerts = (aq.data?.items ?? []).filter((a) => a.kind.includes('kill_switch')).slice(0, 8);
  const broken = mandates.filter((m) => m.integrity && !m.integrity.ok), stopped = mandates.filter((m) => m.stop);
  const shown = lim.effectiveOwner ?? lim.effective;

  return (
    <div className="space-y-4" data-testid="risk">
      <PageTitle onBack={onBack} backLabel={t('settings')}>{t('rkTitle')}</PageTitle>
      <p className="px-1 text-[14px] leading-snug text-mute">{t('rkLead')}</p>
      {fail && <Notice tone="danger">{fail}</Notice>}
      <ApprovalOutcomePanel ap={ap} />

      {(live.ownerOrdersRefused || live.automationOrdersRefused) && <div data-testid="rk-live-banner" data-owner-refused={String(!!live.ownerOrdersRefused)}>
        <Notice tone={live.ownerOrdersRefused ? 'danger' : 'warn'}>
          <b className="block">{t('rkBannerTitle')}</b>
          {live.ownerOrdersRefused ? <><span>{t('rkBannerOwner')}</span><div data-testid="rk-missing-owner"><Names fields={live.missing} /></div></> : <span>{t('rkBannerOwnerOk')}</span>}
          {live.ownerOrdersRefused && (live.missingForAutomation ?? []).join() === live.missing.join() ? <span className="mt-2 block" data-testid="rk-missing-same">{t('rkBannerSame')}</span>
            : live.automationOrdersRefused && (live.missingForAutomation ?? []).length > 0 && <><span className="mt-2 block">{t('rkBannerAuto')}</span><div data-testid="rk-missing-auto"><Names fields={live.missingForAutomation ?? []} /></div></>}
          <span className="mt-2 block"><Btn kind="soft" onClick={() => { setMode('live'); setEditing(true); }} data-testid="rk-banner-edit">{t('rkEdit')}</Btn></span>
        </Notice></div>}

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16.5px] font-semibold">{t('rkKill')}</h2><Tag tone={ks.on ? 'danger' : 'ok'} icon={ks.on ? 'stop' : 'check'} testid="rk-kill-state">{t(ks.on ? 'rkOn' : 'rkOff')}</Tag></div>
        <p className="text-[13.5px] leading-snug text-mute">{t('rkKillBody')}</p>{who(ks)}
        {ks.on ? <Btn full kind="soft" busy={busy === 'kill-switch'} disabled={ap.locked} onClick={() => void release('kill-switch')} data-testid="rk-kill-release"><Icon n="key" className="h-4 w-4" />{t('rkRelease')}</Btn>
          : <><Field label={t('rkReason')}><input className={inputCls} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="rk-kill-reason" /></Field>
            <Btn full kind="danger" busy={busy === 'kill'} onClick={() => void run('kill', () => post('/risk/kill-switch', { reason }))} data-testid="rk-kill-engage"><Icon n="stop" className="h-4 w-4" />{t('rkEngage')}</Btn></>}
      </Card>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16.5px] font-semibold">{t('rkReadOnly')}</h2><Tag tone={ro.on ? 'warn' : 'ok'} icon={ro.on ? 'lock' : 'check'}>{t(ro.on ? 'rkOn' : 'rkOff')}</Tag></div>
        <p className="text-[13.5px] leading-snug text-mute">{t('rkReadOnlyBody')}</p>{who(ro)}
        {ro.on ? <Btn full kind="soft" busy={busy === 'read-only'} disabled={ap.locked} onClick={() => void release('read-only')}><Icon n="key" className="h-4 w-4" />{t('rkRelease')}</Btn>
          : <Btn full kind="soft" busy={busy === 'ro'} onClick={() => void run('ro', () => post('/risk/read-only', { reason }))}><Icon n="lock" className="h-4 w-4" />{t('rkReadOnlyEngage')}</Btn>}
      </Card>

      <Section title={t('rkExposure')}>
        <div className="overflow-x-auto"><Seg label={t('rkExposure')} value={book} options={BOOKS.map((b) => [b, t(`rkBook_${b}` as Key)] as const)} onChange={setBook} /></div>
        {x.error ? <Notice tone="warn">{x.error}</Notice> : <Card className="space-y-4">
          <Notice tone="info">{t('rkBooksNote')}</Notice>
          <StatGrid cols={3}><Stat label={t('rkEquity')} value={num(x.equity)} testid="rk-equity" /><Stat label={t('rkGross')} value={num(x.grossExposure)} /><Stat label={t('rkLeverage')} value={x.leverage ? `${num(x.leverage)}×` : '—'} testid="rk-leverage" /></StatGrid>
          {(x.errors ?? []).map((e) => <Notice key={e} tone="warn">{e}</Notice>)}
          {(x.positions ?? []).length === 0 ? <EmptyState icon="list" title={t('rkNoPositions')} /> : <>
            <div data-testid="rk-by-asset"><h3 className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('rkByAsset')}</h3>
              <dl>{(x.byAsset ?? []).map((a) => <Fact key={a.asset} k={a.asset}>{t('rkNet')} {num(a.net)} USD<span className="mt-0.5 block text-[12.5px] text-mute">{t('rkLong')} {num(a.long)} · {t('rkShort')} {num(a.short)}</span></Fact>)}</dl></div>
            <div data-testid="rk-by-venue"><h3 className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('rkByVenue')}</h3>
              <dl>{(x.byVenue ?? []).map((v) => <Fact key={v.venue} k={v.venue}>{num(v.gross)} USD</Fact>)}</dl></div>
            <div data-testid="rk-liquidation"><h3 className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('rkLiqTitle')}</h3>
              <dl>{(x.positions ?? []).map((p) => { const near = p.liquidationDistanceBps !== null && Number(p.liquidationDistanceBps) < 1000; return (
                <Fact key={`${p.venue}${p.accountId}${p.instrument}${p.side}`} k={<span>{p.instrument}<span className="block text-[12.5px] text-mute">{p.side} {p.size} · {num(p.leverage)}×</span></span>}>
                  {num(p.notional)} USD<span className={`mt-0.5 block text-[12.5px] ${near ? 'font-semibold text-danger' : 'text-mute'}`}>{t('rkLiq')} {p.liquidationPrice ? `${num(p.liquidationPrice)} · ${t('rkLiqAway', { pct: pct(p.liquidationDistanceBps) })}` : '—'}</span></Fact>); })}</dl></div>
          </>}
          {(x.collateral ?? []).length > 0 && <div data-testid="rk-collateral"><h3 className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('rkCollateralTitle')}</h3>
            <dl>{(x.collateral ?? []).map((c) => <Fact key={c.accountId} k={c.venue}>{num(c.equity)} USD{c.shareBps ? ` · ${pct(c.shareBps)}` : ''}<span className="mt-0.5 block text-[12.5px] text-mute">{t('rkFree')} {num(c.freeCollateral)} · {t('rkMargin')} {num(c.marginUsed)}</span></Fact>)}</dl></div>}
        </Card>}
      </Section>

      <Section title={t('rkAlerts')}><Card><div data-testid="rk-alerts">
        {(() => {
          const rows: { key: string; tone: 'danger' | 'warn' | 'info'; title: string; body: string }[] = [];
          if (ks.on) rows.push({ key: 'ks', tone: 'danger', title: t('rkAlertKill'), body: ks.reason ?? '' });
          if (ro.on) rows.push({ key: 'ro', tone: 'warn', title: t('rkAlertReadOnly'), body: ro.reason ?? '' });
          if (live.ownerOrdersRefused) rows.push({ key: 'lim', tone: 'warn', title: t('rkAlertLimits'), body: live.missing.join(', ') });
          for (const m of broken) rows.push({ key: `i${m.id}`, tone: 'danger', title: t('rkAlertIntegrity', { label: m.label }), body: m.integrity?.reason ?? '' });
          for (const m of stopped) rows.push({ key: `s${m.id}`, tone: 'warn', title: t('rkAlertStopped', { label: m.label }), body: m.stop?.detail ?? '' });
          for (const b of BOOKS) for (const e of d.exposure[b].errors ?? []) rows.push({ key: `e${b}${e}`, tone: 'warn', title: t('rkAlertUnreadable', { book: t(`rkBook_${b}` as Key) }), body: e });
          if (rows.length === 0 && riskAlerts.length === 0) return <EmptyState icon="check" title={t('rkNoAlerts')} />;
          return <ul className="divide-y divide-line">
            {rows.map((r) => <li key={r.key} className="py-2.5"><div className="flex flex-wrap items-center gap-2"><Tag tone={r.tone}>{t('rkAlertNow')}</Tag><span className="text-[13.5px] font-medium">{r.title}</span></div>{r.body && <p className="mt-1 break-words text-[12.5px] leading-snug text-mute">{r.body}</p>}</li>)}
            {riskAlerts.map((a) => { const text = renderAlert(a.kind, localizeAlertParams(a.params, locale), locale, true); return (
              <li key={a.id} className="py-2.5"><span className="text-[13.5px] font-medium">{text.title}</span><p className="mt-1 break-words text-[12.5px] leading-snug text-mute">{when(new Date(a.ts), locale)}{text.body ? ` · ${text.body}` : ''}</p></li>); })}
          </ul>;
        })()}
      </div></Card></Section>

      <Section title={t('rkLimits')}>
        <Seg label={t('rkLimits')} value={mode} options={[['live', t('rkModeLive')], ['paper', t('rkModePaper')]]} onChange={(m) => { setMode(m); setEditing(false); }} />
        <Card className="space-y-3">
          {editing ? <LimitsEditor key={mode} view={lim} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); refresh(); }} onError={err} /> : <>
            {mode === 'live' && lim.seed && lim.seed.sources.length > 0 && <Fold summary={t('rkSeedTitle', { n: lim.seed.sources.length })} testid="rk-seed">
              <p className="text-[12.5px] leading-snug text-mute">{t('rkSeedBody', { date: when(new Date(lim.seed.at), locale) })}</p>
              <dl>{lim.seed.sources.map((s) => <Fact key={s.field} k={t(`rkL_${s.field}` as Key)}>{limitText(lim.seed!.limits[s.field])}<span className="mt-0.5 block text-[12.5px] text-mute">{s.from}</span></Fact>)}</dl></Fold>}
            {LIMIT_GROUPS.map((g) => <div key={g.id}><h3 className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t(`rkLG_${g.id}` as Key)}</h3>
              <dl>{g.fields.map((f) => { const v = shown[f.key], own = f.key in lim.stored, seeded = !own && lim.seed !== undefined && f.key in lim.seed.limits; return (
                <Fact key={f.key} k={t(`rkL_${f.key}` as Key)} testid={`rk-limit-${f.key}`}>{v === undefined ? <Tag tone={mode === 'live' ? 'danger' : 'mute'}>{t('rkUnset')}</Tag> : <span className="break-words">{limitText(v)}</span>}
                  {v !== undefined && <span className="mt-0.5 block text-[12.5px] text-mute">{own ? t('rkYours') : seeded ? t('rkSeededTag') : t('rkDefault')}</span>}</Fact>); })}</dl></div>)}
            <Btn full kind="soft" onClick={() => setEditing(true)} data-testid="rk-limits-edit">{t('rkEdit')}</Btn></>}
        </Card>
      </Section>

      <Section title={t('rkLocks')}><Card><dl>{d.locks.map((l) => <Fact key={l.id} k={<span className="font-mono text-[12.5px]">{l.id}</span>}><Tag tone={l.on ? 'ok' : 'mute'}>{t(l.on ? 'rkOn' : 'rkOff')}</Tag><span className="mt-1 block text-[12.5px] text-mute">{l.why}</span></Fact>)}</dl></Card></Section>

      {/* V11 market making — quoting mandates: listed, revoked and approved through their OWN sheet (the enforced-by table, four hashes); created from the agent's go-live flow */}
      <Suspense fallback={null}><QuotingMandatesBlock mandates={mandates} onChanged={refresh} /></Suspense>

      <Section title={t('rkMandates')} right={<Btn kind="soft" onClick={() => { setFail(''); setCreating(true); }} data-testid="rk-mandate-new"><Icon n="plus" className="h-4 w-4" />{t('rkNew')}</Btn>}>
        {wanted && mq.data && !wantedFound && <Notice tone="warn"><span data-testid="rk-mandate-unknown">{t('v11LoMandateUnknown')}</span></Notice>}
        {mq.isError ? <ErrorState title={t('rkLoadError')} onRetry={() => void mq.refetch()} /> : mandates.length === 0 ? <Card><EmptyState icon="key" title={t('rkNoMandates')}>{t('rkNoMandatesBody')}</EmptyState></Card>
          : mandates.map((m) => <Card key={m.id} className={`space-y-3 ${m.id === wanted ? 'ring-2 ring-blue' : ''}`}>
            <div className="flex scroll-mt-24 flex-wrap items-start justify-between gap-2 outline-none" data-testid={`rk-mandate-${m.id}`} data-mandate-card={m.id} data-wanted={String(m.id === wanted)} tabIndex={-1}><div className="min-w-0"><h3 className="break-words text-[15.5px] font-semibold">{m.label}</h3><p className="break-all font-mono text-[12px] text-mute">{m.principal.kind}:{m.principal.id}</p></div>
              <Tag tone={m.phase === 'active' ? 'ok' : m.phase === 'wind_down' ? 'warn' : m.state === 'created' || m.state === 'pending_signer' ? 'info' : 'mute'}>{m.mode} · {t(`rkPhase_${m.phase}` as Key)}</Tag></div>
            {m.integrity && !m.integrity.ok && <Notice tone="danger"><b>{t('rkIntegrityBad')}</b> {m.integrity.reason}</Notice>}
            <dl><Fact k={t('rkUsage')}>{t('rkUsageBody', { accepted: m.usage.ordersAccepted, rejected: m.usage.ordersRejected, today: m.usage.ordersToday, open: m.usage.openOrders })}</Fact>
              <Fact k={t('rkUntil')}>{when(new Date(m.notAfter), locale)}</Fact>{m.stop && <Fact k={t('rkStopped')}>{m.stop.detail}</Fact>}
              <Fact k={t('rkHashFull')}><span className="break-all font-mono text-[12px]">{m.hash}</span></Fact>
              {m.approval && <Fact k={t('rkApprovedHash')}><Tag tone={m.integrity?.ok ? 'ok' : 'danger'} icon={m.integrity?.ok ? 'check' : 'x'}>{t(m.integrity?.ok ? 'rkIntegrityOk' : 'rkIntegrityBad')}</Tag><span className="mt-0.5 block text-[12.5px] text-mute">{when(new Date(m.approval.approvedAt), locale)}</span></Fact>}</dl>
            <Fold summary={t('rkFields')} open={m.id === wanted}><MandateFields mandate={m.mandate} /></Fold>
            <Fold summary={t('rkEnforcement')} open={m.id === wanted}><EnforcementTable rows={m.enforcement} /></Fold>
            <div className="grid grid-cols-2 gap-2.5">
              {(m.state === 'created' || m.state === 'pending_signer') && (m as { kind?: string }).kind !== 'quoting' && <Btn busy={busy === `prep-${m.id}`} onClick={() => void openApproval(m.id)} data-testid={`rk-approve-${m.id}`}>{t('rkReview')}</Btn>}
              {(m.state === 'active' || m.state === 'created' || m.state === 'pending_signer') && <Btn kind="ghost" className="!text-danger" busy={busy === `rev-${m.id}`} onClick={() => void run(`rev-${m.id}`, () => post(`/mandates/${m.id}/revoke`, {}))}><Icon n="stop" className="h-4 w-4" />{t('rkRevoke')}</Btn>}
            </div></Card>)}
      </Section>

      <Section title={t('rkDecisions')}><Card>
        {d.decisions.length === 0 ? <EmptyState icon="list" title={t('rkNoDecisions')} /> : <ul className="divide-y divide-line" data-testid="rk-decisions">{d.decisions.map((r) => <li key={r.id} className="py-2.5" data-testid="rk-decision" data-decision={r.decision} data-reducing={String(r.reducing)} data-failed={r.failing.map((f) => f.id).join(',')}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13.5px] font-medium">{r.instrument ?? r.kind} · {r.mode}{r.preview ? ` · ${t('rkPreview')}` : ''}</span>
            <Tag tone={r.decision === 'allow' ? 'ok' : 'danger'} icon={r.decision === 'allow' ? 'check' : 'x'}>{t(r.decision === 'allow' ? 'rkAllowed' : 'rkDenied')}{r.reducing ? ` · ${t('rkReducing')}` : ''}</Tag></div>
          <p className="mt-1 text-[12.5px] leading-snug text-mute">{when(new Date(r.at), locale)} · {r.principal.kind}:{r.principal.id}</p>
          {r.failing.length > 0 && <ul className="mt-1.5 space-y-1">{r.failing.map((f) => <li key={f.id} className="rounded-xl bg-elev px-3 py-2 text-[12.5px] leading-snug"><span className="font-mono font-semibold text-danger">{f.id}</span> — {f.detail}
            {(f.observed !== null || f.limit !== null) && <span className="block text-mute">{t('rkObserved')} {f.observed ?? '—'} · {t('rkLimit')} {f.limit ?? '—'}</span>}</li>)}</ul>}</li>)}</ul>}
      </Card></Section>

      {sheet && <MandateApprovalSheet sheet={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); refresh(); }} onError={err} />}
      {creating && <MandateForm onClose={() => setCreating(false)} onError={err} onCreated={(id) => { setCreating(false); refresh(); void openApproval(id); }} />}
    </div>
  );
}
