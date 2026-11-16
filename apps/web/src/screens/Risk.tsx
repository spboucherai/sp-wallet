// V11 — Risk: the owner's controls of the independent risk engine and of the trading mandates (/api/v1/risk, /api/v1/mandates,
// owner session only). Kill switch and read-only mode (engaging is free, releasing needs the passkey), the limits (loosening
// needs the passkey), live exposure, the last decisions of the engine, and the mandates: the approval sheet shows every field and,
// field by field, what the isolated signer enforces and what only the API enforces — before the passkey prompt.
// Every figure comes from the server; nothing is computed or assumed here.
import { useContext, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post, type ApiError } from '../api';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Card, EmptyState, ErrorState, Fact, Field, Fold, Icon, inputCls, Notice, PageTitle, Section, Seg, Sheet, SkeletonCard, Stat, StatGrid, Tag, when, type Tone } from '../ui';

interface Switch { on: boolean; at: number | null; by: { kind: string; id: string } | null; reason: string | null }
interface Limits { mode: 'paper' | 'live'; stored: Record<string, unknown>; effective: Record<string, unknown>; missing: string[] }
interface Exposure { book: string; error?: string; equity?: string; grossExposure?: string; leverage?: string | null; errors?: string[];
  byAsset?: { asset: string; long: string; short: string; net: string }[]; byVenue?: { venue: string; gross: string }[];
  collateral?: { venue: string; accountId: string; equity: string; freeCollateral: string; shareBps: string | null }[];
  positions?: { venue: string; instrument: string; side: string; size: string; notional: string; leverage: string; liquidationPrice: string | null; liquidationDistanceBps: string | null }[] }
interface Decision { id: number; at: number; kind: string; preview: boolean; principal: { kind: string; id: string }; mode: string; venue: string; instrument: string | null; decision: 'allow' | 'deny'; reducing: boolean; failing: { id: string; detail: string }[] }
interface State { switches: { killSwitch: Switch; readOnly: Switch }; limits: { paper: Limits; live: Limits }; exposure: { paper: Exposure; live: Exposure; liveTestnet: Exposure }; decisions: Decision[]; locks: { id: string; on: boolean; why: string }[] }
interface Enforcement { field: string; enforcedBy: 'signer' | 'signer_partial' | 'api_only' | 'not_applicable'; signerField: string | null; note: string }
interface Mandate { id: string; principal: { kind: string; id: string }; mode: 'paper' | 'live'; state: string; phase: string; hash: string; label: string; mandate: Record<string, unknown>; enforcement: Enforcement[];
  usage: { ordersAccepted: number; ordersRejected: number; ordersToday: number; openOrders: number; notionalTotal: string }; stop: { code: string; detail: string } | null; notAfter: number }
interface Sheet0 { mandateId: string; mandate: Record<string, unknown>; hash: string; mode: string; enforcement: Enforcement[]; passkey: boolean; note: string;
  signer: { hash: string; options: unknown; acknowledgement: { text: string; title?: string }; warning?: string } | null }

const ENF_TONE: Record<Enforcement['enforcedBy'], Tone> = { signer: 'ok', signer_partial: 'warn', api_only: 'danger', not_applicable: 'mute' };
const BOOKS = ['paper', 'live', 'liveTestnet'] as const;
const num = (x: string | null | undefined, d = 2): string => { if (x === null || x === undefined) return '—'; const n = Number(x); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : x; };
const TEMPLATE = { principal: { kind: 'api_key', id: 'spk_…' }, mode: 'paper', accountIds: ['<account id>'], instruments: ['hyperliquid:BTC'], orderTypes: ['market', 'limit'], maxCapitalUsd: '1000', maxOrderNotionalUsd: '500', maxPositionNotionalUsd: '1000',
  maxLeverage: '2', maxDailyLossUsd: '50', floorEquityUsd: '500', days: 7, frequency: { perMinute: 5, perHour: 20, perDay: 40 }, maxSlippageBps: 50, maxFeeUsd: '5', stopConditions: [{ kind: 'consecutive_rejects_gte', count: 5 }], label: 'Mandate' };

/** the sentence of an error of the risk routes; a cancelled passkey prompt says nothing */
function useErr() {
  const t = useT();
  return (e: unknown): string => { const x = e as ApiError & { name?: string }; if (x?.name === 'NotAllowedError') return ''; return t('rkErr', { code: x?.code ?? 'error', message: x?.message ?? '' }); };
}
const Table = ({ rows }: { rows: Enforcement[] }) => { const t = useT(); return (
  <ul className="divide-y divide-line" data-testid="rk-enforcement">{rows.map((e) => <li key={e.field} className="py-2.5">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[13px]">{e.field}</span><Tag tone={ENF_TONE[e.enforcedBy]}>{t(`rkEnf_${e.enforcedBy}` as Key)}</Tag></div>
    <p className="mt-1 text-[12.5px] leading-snug text-mute">{e.signerField ? `${e.signerField} — ` : ''}{e.note}</p></li>)}</ul>); };

export function Risk({ onBack }: { onBack: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient(); const err = useErr();
  const q = useQuery({ queryKey: ['risk', 'state'], queryFn: () => get<State>('/risk/state'), refetchInterval: 20_000 });
  const mq = useQuery({ queryKey: ['risk', 'mandates'], queryFn: () => get<{ mandates: Mandate[] }>('/mandates'), refetchInterval: 30_000 });
  const [busy, setBusy] = useState(''); const [fail, setFail] = useState(''); const [reason, setReason] = useState('');
  const [book, setBook] = useState<(typeof BOOKS)[number]>('live'); const [mode, setMode] = useState<'paper' | 'live'>('live');
  const [edit, setEdit] = useState<string | null>(null); const [loosened, setLoosened] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState<Sheet0 | null>(null); const [ack, setAck] = useState(false); const [draft, setDraft] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['risk'] }); };
  const run = async (id: string, fn: () => Promise<unknown>): Promise<boolean> => { setBusy(id); setFail(''); try { await fn(); refresh(); return true; } catch (e) { setFail(err(e)); return false; } finally { setBusy(''); } };

  /** releasing a switch: the server prepares the intent, the passkey signs its hash */
  const release = (kind: 'kill-switch' | 'read-only') => run(kind, async () => {
    const p = await post(`/risk/${kind}/release/prepare`, {});
    await post(`/risk/${kind}/release`, p.needed ? { assertion: await startAuthentication({ optionsJSON: p.options }) } : {});
  });
  const saveLimits = (confirmed: boolean) => run('limits', async () => {
    const limits = JSON.parse(edit ?? '{}') as unknown;
    const p = await post(`/risk/limits/${mode}/prepare`, { limits });
    if (!p.needed) { await post(`/risk/limits/${mode}`, { limits }); setEdit(null); setLoosened(null); return; }
    if (!confirmed) { setLoosened(p.loosened as string[]); return; }          // shown first: which limits become looser
    await post(`/risk/limits/${mode}/approve`, { assertion: await startAuthentication({ optionsJSON: p.options }) });
    setEdit(null); setLoosened(null);
  });
  const openApproval = (m: Mandate) => run(`prep-${m.id}`, async () => { setAck(false); setSheet(await post(`/mandates/${m.id}/approve/prepare`, { locale })); });
  const approve = () => run('approve', async () => {
    if (!sheet) return;
    await post(`/mandates/${sheet.mandateId}/approve`, sheet.passkey && sheet.signer ? { assertion: await startAuthentication({ optionsJSON: sheet.signer.options as never }), acknowledged: true } : {});
    setSheet(null);
  });

  if (q.isLoading) return <div className="space-y-4"><PageTitle onBack={onBack} backLabel={t('settings')}>{t('rkTitle')}</PageTitle><SkeletonCard lines={4} /><SkeletonCard lines={3} /></div>;
  if (q.isError || !q.data) return <div className="space-y-4"><PageTitle onBack={onBack} backLabel={t('settings')}>{t('rkTitle')}</PageTitle><ErrorState title={t('rkLoadError')} onRetry={() => void q.refetch()} /></div>;
  const d = q.data, ks = d.switches.killSwitch, ro = d.switches.readOnly, x = d.exposure[book], lim = d.limits[mode];
  const who = (s: Switch): ReactNode => s.on ? <span className="text-[12.5px] text-mute">{s.by ? `${s.by.kind}:${s.by.id}` : ''}{s.at ? ` · ${when(new Date(s.at), locale)}` : ''}{s.reason ? ` · ${s.reason}` : ''}</span> : null;

  return (
    <div className="space-y-4" data-testid="risk">
      <PageTitle onBack={onBack} backLabel={t('settings')}>{t('rkTitle')}</PageTitle>
      <p className="px-1 text-[14px] leading-snug text-mute">{t('rkLead')}</p>
      {fail && <Notice tone="danger">{fail}</Notice>}

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16.5px] font-semibold">{t('rkKill')}</h2><Tag tone={ks.on ? 'danger' : 'ok'} icon={ks.on ? 'stop' : 'check'} testid="rk-kill-state">{t(ks.on ? 'rkOn' : 'rkOff')}</Tag></div>
        <p className="text-[13.5px] leading-snug text-mute">{t('rkKillBody')}</p>{who(ks)}
        {ks.on ? <Btn full kind="soft" busy={busy === 'kill-switch'} onClick={() => void release('kill-switch')} data-testid="rk-kill-release"><Icon n="key" className="h-4 w-4" />{t('rkRelease')}</Btn>
          : <><Field label={t('rkReason')}><input className={inputCls} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
            <Btn full kind="danger" busy={busy === 'kill'} onClick={() => void run('kill', () => post('/risk/kill-switch', { reason }))} data-testid="rk-kill-engage"><Icon n="stop" className="h-4 w-4" />{t('rkEngage')}</Btn></>}
      </Card>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16.5px] font-semibold">{t('rkReadOnly')}</h2><Tag tone={ro.on ? 'warn' : 'ok'} icon={ro.on ? 'lock' : 'check'}>{t(ro.on ? 'rkOn' : 'rkOff')}</Tag></div>
        <p className="text-[13.5px] leading-snug text-mute">{t('rkReadOnlyBody')}</p>{who(ro)}
        {ro.on ? <Btn full kind="soft" busy={busy === 'read-only'} onClick={() => void release('read-only')}><Icon n="key" className="h-4 w-4" />{t('rkRelease')}</Btn>
          : <Btn full kind="soft" busy={busy === 'ro'} onClick={() => void run('ro', () => post('/risk/read-only', { reason }))}><Icon n="lock" className="h-4 w-4" />{t('rkReadOnlyEngage')}</Btn>}
      </Card>

      <Section title={t('rkExposure')}>
        <div className="overflow-x-auto"><Seg label={t('rkExposure')} value={book} options={BOOKS.map((b) => [b, t(`rkBook_${b}` as Key)] as const)} onChange={setBook} /></div>
        {x.error ? <Notice tone="warn">{x.error}</Notice> : <Card className="space-y-3">
          <Notice tone="info">{t('rkBooksNote')}</Notice>
          <StatGrid cols={3}><Stat label={t('rkEquity')} value={num(x.equity)} /><Stat label={t('rkGross')} value={num(x.grossExposure)} /><Stat label={t('rkLeverage')} value={x.leverage ? `${num(x.leverage)}×` : '—'} /></StatGrid>
          {(x.errors ?? []).map((e) => <Notice key={e} tone="warn">{e}</Notice>)}
          {(x.positions ?? []).length === 0 ? <EmptyState icon="list" title={t('rkNoPositions')} /> : <dl>
            {(x.byAsset ?? []).map((a) => <Fact key={a.asset} k={`${a.asset} · ${t('rkNet')}`}>{num(a.net)} USD</Fact>)}
            {(x.byVenue ?? []).map((v) => <Fact key={v.venue} k={`${v.venue} · ${t('rkGross')}`}>{num(v.gross)} USD</Fact>)}
            {(x.positions ?? []).map((p) => <Fact key={`${p.venue}${p.instrument}${p.side}`} k={`${p.instrument} · ${p.side} ${p.size}`}>{num(p.notional)} USD · {num(p.leverage)}× · {t('rkLiq')} {p.liquidationPrice ? `${num(p.liquidationPrice)} (${p.liquidationDistanceBps ? `${num(String(Number(p.liquidationDistanceBps) / 100))} %` : '—'})` : '—'}</Fact>)}
          </dl>}
          {(x.collateral ?? []).length > 0 && <dl>{(x.collateral ?? []).map((c) => <Fact key={c.accountId} k={`${t('rkCollateral')} · ${c.venue}`}>{num(c.equity)} USD{c.shareBps ? ` · ${num(String(Number(c.shareBps) / 100), 1)} %` : ''}</Fact>)}</dl>}
        </Card>}
      </Section>

      <Section title={t('rkLimits')}>
        <Seg label={t('rkLimits')} value={mode} options={[['live', t('rkModeLive')], ['paper', t('rkModePaper')]]} onChange={(m) => { setMode(m); setEdit(null); setLoosened(null); }} />
        <Card className="space-y-3">
          {lim.missing.length > 0 && <Notice tone="warn"><b>{t('rkMissingTitle')}</b> {t('rkMissingBody')} <span className="font-mono text-[12.5px]">{lim.missing.join(', ')}</span></Notice>}
          <dl>{Object.entries(lim.effective).map(([k, v]) => <Fact key={k} k={k} mono>{typeof v === 'object' ? JSON.stringify(v) : String(v)}{k in lim.stored ? '' : ` · ${t('rkDefault')}`}</Fact>)}</dl>
          {edit === null ? <Btn full kind="soft" onClick={() => { setEdit(JSON.stringify(lim.stored, null, 2)); setLoosened(null); }} data-testid="rk-limits-edit">{t('rkEdit')}</Btn> : <div className="space-y-3">
            <Field label={t('rkLimitsJson')} hint={t('rkLimitsHint')}><textarea className={`${inputCls} min-h-48 font-mono text-[12.5px]`} value={edit} spellCheck={false} onChange={(e) => { setEdit(e.target.value); setLoosened(null); }} data-testid="rk-limits-json" /></Field>
            {loosened && <Notice tone="warn"><b>{t('rkLoosens')}</b> <span className="font-mono text-[12.5px]">{loosened.join(', ')}</span> — {t('rkLoosensBody')}</Notice>}
            <div className="grid grid-cols-2 gap-2.5"><Btn kind="ghost" onClick={() => { setEdit(null); setLoosened(null); }}>{t('cancel')}</Btn>
              <Btn busy={busy === 'limits'} onClick={() => void saveLimits(loosened !== null)} data-testid="rk-limits-save">{loosened ? <><Icon n="key" className="h-4 w-4" />{t('approve')}</> : t('rkSave')}</Btn></div></div>}
        </Card>
      </Section>

      <Section title={t('rkLocks')}><Card><dl>{d.locks.map((l) => <Fact key={l.id} k={<span className="font-mono text-[12.5px]">{l.id}</span>}><Tag tone={l.on ? 'ok' : 'mute'}>{t(l.on ? 'rkOn' : 'rkOff')}</Tag><span className="mt-1 block text-[12.5px] text-mute">{l.why}</span></Fact>)}</dl></Card></Section>

      <Section title={t('rkMandates')} right={<Btn kind="soft" onClick={() => setDraft(JSON.stringify(TEMPLATE, null, 2))} data-testid="rk-mandate-new"><Icon n="plus" className="h-4 w-4" />{t('rkNew')}</Btn>}>
        {mq.isError ? <ErrorState title={t('rkLoadError')} onRetry={() => void mq.refetch()} /> : (mq.data?.mandates ?? []).length === 0 ? <Card><EmptyState icon="key" title={t('rkNoMandates')}>{t('rkNoMandatesBody')}</EmptyState></Card>
          : (mq.data?.mandates ?? []).map((m) => <Card key={m.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2" data-testid={`rk-mandate-${m.id}`}><div className="min-w-0"><h3 className="break-words text-[15.5px] font-semibold">{m.label}</h3><p className="font-mono text-[12px] text-mute">{m.principal.kind}:{m.principal.id}</p></div>
              <Tag tone={m.phase === 'active' ? 'ok' : m.phase === 'wind_down' ? 'warn' : m.state === 'created' || m.state === 'pending_signer' ? 'info' : 'mute'}>{m.mode} · {t(`rkPhase_${m.phase}` as Key)}</Tag></div>
            <dl><Fact k={t('rkUsage')}>{t('rkUsageBody', { accepted: m.usage.ordersAccepted, rejected: m.usage.ordersRejected, today: m.usage.ordersToday, open: m.usage.openOrders })}</Fact>
              <Fact k={t('rkUntil')}>{when(new Date(m.notAfter), locale)}</Fact>{m.stop && <Fact k={t('rkStopped')}>{m.stop.detail}</Fact>}<Fact k={t('rkHash')} mono>{m.hash.slice(0, 24)}…</Fact></dl>
            <Fold summary={t('rkFields')}><pre tabIndex={0} className="max-h-72 overflow-auto rounded-2xl bg-elev p-3 font-mono text-[12px] leading-relaxed">{JSON.stringify(m.mandate, null, 2)}</pre></Fold>
            <Fold summary={t('rkEnforcement')}><Table rows={m.enforcement} /></Fold>
            <div className="grid grid-cols-2 gap-2.5">
              {(m.state === 'created' || m.state === 'pending_signer') && <Btn busy={busy === `prep-${m.id}`} onClick={() => void openApproval(m)} data-testid={`rk-approve-${m.id}`}>{t('rkReview')}</Btn>}
              {(m.state === 'active' || m.state === 'created' || m.state === 'pending_signer') && <Btn kind="ghost" className="!text-danger" busy={busy === `rev-${m.id}`} onClick={() => void run(`rev-${m.id}`, () => post(`/mandates/${m.id}/revoke`, {}))}><Icon n="stop" className="h-4 w-4" />{t('rkRevoke')}</Btn>}
            </div></Card>)}
      </Section>

      <Section title={t('rkDecisions')}><Card>
        {d.decisions.length === 0 ? <EmptyState icon="list" title={t('rkNoDecisions')} /> : <ul className="divide-y divide-line">{d.decisions.map((r) => <li key={r.id} className="py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13.5px] font-medium">{r.instrument ?? r.kind} · {r.mode}{r.preview ? ` · ${t('rkPreview')}` : ''}</span>
            <Tag tone={r.decision === 'allow' ? 'ok' : 'danger'} icon={r.decision === 'allow' ? 'check' : 'x'}>{t(r.decision === 'allow' ? 'rkAllowed' : 'rkDenied')}{r.reducing ? ` · ${t('rkReducing')}` : ''}</Tag></div>
          <p className="mt-1 text-[12.5px] leading-snug text-mute">{when(new Date(r.at), locale)} · {r.principal.kind}:{r.principal.id}{r.failing.length ? ` · ${r.failing.map((f) => `${f.id}: ${f.detail}`).join(' ; ')}` : ''}</p></li>)}</ul>}
      </Card></Section>

      {sheet && <Sheet title={t('rkSheetTitle')} sub={String(sheet.mandate.label ?? '')} onClose={() => setSheet(null)} busy={busy === 'approve'} wide testid="rk-sheet"
        footer={<Btn full busy={busy === 'approve'} disabled={sheet.passkey && !ack} onClick={() => void approve()} data-testid="rk-sheet-approve">{sheet.passkey ? <><Icon n="key" className="h-4 w-4" />{t('rkSheetPasskey')}</> : t('rkSheetApprove')}</Btn>}>
        <div className="space-y-3">
          <Notice tone={sheet.passkey ? 'warn' : 'info'}>{sheet.note}</Notice>
          <dl><Fact k={t('rkHash')} mono>{sheet.hash}</Fact>{sheet.signer && <Fact k={t('rkSignerHash')} mono>{sheet.signer.hash}</Fact>}</dl>
          <h3 className="text-[14px] font-semibold">{t('rkFields')}</h3>
          <pre tabIndex={0} className="max-h-64 overflow-auto rounded-2xl bg-elev p-3 font-mono text-[12px] leading-relaxed" data-testid="rk-sheet-fields">{JSON.stringify(sheet.mandate, null, 2)}</pre>
          <h3 className="text-[14px] font-semibold">{t('rkEnforcement')}</h3>
          <p className="text-[12.5px] leading-snug text-mute">{t('rkEnforcementBody')}</p>
          <Table rows={sheet.enforcement} />
          {sheet.signer && <><h3 className="text-[14px] font-semibold">{sheet.signer.acknowledgement.title ?? t('rkAck')}</h3>
            <p className="whitespace-pre-wrap rounded-2xl bg-elev p-3 text-[13px] leading-relaxed">{sheet.signer.acknowledgement.text}</p>
            {sheet.signer.warning && <Notice tone="warn">{sheet.signer.warning}</Notice>}
            <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-[18px] w-[18px] shrink-0 accent-blue" data-testid="rk-sheet-ack" /><span className="text-[14px]">{t('rkAckCheck')}</span></label></>}
          {fail && <Notice tone="danger">{fail}</Notice>}
        </div></Sheet>}

      {draft !== null && <Sheet title={t('rkNewTitle')} onClose={() => setDraft(null)} busy={busy === 'create'} wide testid="rk-new"
        footer={<Btn full busy={busy === 'create'} onClick={() => void run('create', async () => { await post('/mandates', JSON.parse(draft)); }).then((ok) => { if (ok) setDraft(null); })}>{t('rkCreate')}</Btn>}>
        <div className="space-y-3"><Notice tone="info">{t('rkNewBody')}</Notice>
          <Field label={t('rkNewJson')}><textarea className={`${inputCls} min-h-72 font-mono text-[12.5px]`} value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} data-testid="rk-new-json" /></Field>
          {fail && <Notice tone="danger">{fail}</Notice>}</div></Sheet>}
    </div>
  );
}
