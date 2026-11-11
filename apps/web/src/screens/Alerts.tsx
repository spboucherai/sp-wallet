import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { ALERT_DEFS, alertPath, renderAlert, type AlertDef, type AlertGroup } from '../../../../packages/core/src/alert-catalog';
import { localizeAlertParams } from '../reasonTexts';
import { api, get, post } from '../api';
import { defaultLabel, disablePush, enablePush, isIos, pushState, thisDevice, type AlertItem, type Device, type PushState, type Unread } from '../alerts';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Chips, EmptyState, ErrorState, Field, Icon, inputCls, NetworkIcon, Notice, PageTitle, Section, Seg, SkeletonCard, Tag, when, type Tone } from '../ui';

interface SettingsT {
  rules: Record<string, boolean>; quiet: { enabled: boolean; start: string; end: string; tz: string }; showDetails: boolean; capPerHour: number;
  thresholds: Record<string, number>; webhook: { enabled: boolean; url: string; details: boolean };
}
interface SettingsView { settings: SettingsT; kinds: { kind: string; group: AlertGroup; severity: string; default: boolean; fixed: boolean }[]; webhook: { secretSet: boolean }; webhookSample: unknown }
/** severity is always an icon and a word, never a colour alone: `plate` tints the icon plate, `tone` the word's pill */
const SEV: Record<string, { icon: string; plate: string; tone: Tone; key: Key }> = {
  critical: { icon: 'stop', plate: 'text-danger bg-danger/10', tone: 'danger', key: 'alSevCritical' }, warning: { icon: 'warn', plate: 'text-warn bg-warn/12', tone: 'warn', key: 'alSevWarning' }, info: { icon: 'bell', plate: 'text-blue bg-blue/10', tone: 'info', key: 'alSevInfo' },
};
const GROUPS: AlertGroup[] = ['transfers', 'agents', 'derivatives', 'security', 'system'];
const groupKey = (g: string) => `alGroup_${g}` as Key;

/** A switch: a 51 × 31 track inside a 44 px touch target; the thumb's side says the state, the colour only repeats it. */
function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className="group relative inline-flex h-11 w-[51px] shrink-0 items-center disabled:opacity-45">
    <span className={`h-[31px] w-[51px] rounded-full transition-colors ${on ? 'bg-emerald' : 'bg-[color-mix(in_srgb,var(--mute)_34%,var(--elev))]'}`} />
    <span className={`absolute left-0.5 top-1/2 -mt-[13.5px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(13,18,32,0.28)] transition-transform duration-200 ease-spring ${on ? 'translate-x-5' : ''}`} /></button>;
}
/** the severity's icon on its tinted round plate (the word is written next to it by the caller) */
function SevPlate({ s, size = 'h-10 w-10' }: { s: string; size?: string }) {
  const x = SEV[s] ?? SEV.info!;
  return <span className={`grid shrink-0 place-items-center rounded-full ${size} ${x.plate}`} aria-hidden="true"><Icon n={x.icon} className={size === 'h-10 w-10' ? 'h-5 w-5' : 'h-4 w-4'} /></span>;
}
function SevWord({ s }: { s: string }) { const t = useT(), x = SEV[s] ?? SEV.info!; return <Tag tone={x.tone}>{t(x.key)}</Tag>; }

export function Alerts({ view, open, setView }: { view: 'list' | 'settings'; open: (path: string) => void; setView: (v: 'list' | 'settings') => void }) {
  const t = useT();
  return (
    <div className="space-y-4" data-testid="alerts-screen">
      <PageTitle>{t('alTitle')}</PageTitle>
      <Seg role="tablist" label={t('alTitle')} value={view} onChange={setView} options={[['list', t('alTabList')], ['settings', t('alTabSettings')]] as const} />
      {view === 'list' ? <AlertList open={open} /> : <AlertSettings />}
    </div>
  );
}

/** skeleton of the inbox: rows shaped like the alert rows (plate, title, sentence, meta) */
function InboxSkeleton() {
  return <div aria-hidden="true"><div className="skel mb-2 ml-1 h-3 w-24 !rounded-md" /><div className="card divide-y divide-line overflow-hidden">{[72, 88, 60, 80].map((w, k) => <div key={k} className="flex items-start gap-3.5 px-4 py-3.5">
    <div className="skel h-10 w-10 !rounded-full" /><div className="flex-1 space-y-2 pt-0.5"><div className="skel h-3.5 !rounded-md" style={{ width: `${w - 28}%` }} /><div className="skel h-3 !rounded-md" style={{ width: `${w}%` }} /><div className="skel h-3 w-24 !rounded-md" /></div></div>)}</div></div>;
}

function AlertList({ open }: { open: (path: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [sev, setSev] = useState<'all' | 'critical' | 'warning' | 'info'>('all'), [group, setGroup] = useState<'all' | AlertGroup>('all'), [limit, setLimit] = useState(40);
  const q = useQuery({ queryKey: ['alerts', sev, group, limit], queryFn: () => get<{ items: AlertItem[] } & Unread>(`/alerts?limit=${limit}${sev !== 'all' ? `&severity=${sev}` : ''}${group !== 'all' ? `&group=${group}` : ''}`), refetchInterval: 60_000 });
  // an alert that arrives while this list is being fetched is not in that answer: the live counter knows a newer id, so fetch again
  const live = useQuery({ queryKey: ['alerts-unread'], queryFn: () => get<Unread>('/alerts/unread'), staleTime: 30_000 });
  const newest = live.data?.lastId ?? 0, have = q.data?.lastId ?? 0, fetching = q.isFetching, refetch = q.refetch;
  useEffect(() => { if (have > 0 && newest > have && !fetching) void refetch(); }, [newest, have, fetching, refetch]);
  const mark = async (body: { all: true } | { ids: number[] }) => { qc.setQueryData(['alerts-unread'], await post<Unread>('/alerts/read', body)); void qc.invalidateQueries({ queryKey: ['alerts'] }); };
  const items = q.data?.items ?? [];
  // grouped by calendar day (the device's own), like Activity: "Aujourd'hui", "Hier", then the date in full
  const loc = locale === 'fr' ? 'fr-CA' : 'en-CA', dayKey = (d: number) => new Date(d).toLocaleDateString('en-CA');
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86_400_000);
  const dayLabel = (k: string, at: number) => k === today ? t('dsToday') : k === yesterday ? t('dsYesterday') : new Date(at).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', ...(k.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
  const days: { key: string; label: string; items: AlertItem[] }[] = [];
  for (const a of items) { const k = dayKey(a.ts), g = days[days.length - 1]; if (g && g.key === k) g.items.push(a); else days.push({ key: k, label: dayLabel(k, a.ts), items: [a] }); }
  // "il y a 12 min", "il y a 3 h"; past a day the group label gives the date and the row its time
  const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto', style: 'short' });
  const rel = (ts: number) => { const d = Date.now() - ts; return d < 45_000 ? rtf.format(0, 'second') : d < 3_570_000 ? rtf.format(-Math.max(1, Math.round(d / 60_000)), 'minute') : d < 86_400_000 ? rtf.format(-Math.round(d / 3_600_000), 'hour') : new Date(ts).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }); };
  /** what the row opens, said in words (the whole row is the link) */
  const subject = (a: AlertItem): string => { const p = alertPath(a.kind, a.subject as never), name = (k: string) => (typeof a.params[k] === 'string' && !String(a.params[k]).startsWith('@') ? ` · ${a.params[k]}` : '');
    return p.startsWith('/agents/') ? `${t('moAgent')}${name('agent')}` : p === '/agents' ? t('agents') : p.startsWith('/plan/') ? t('dzAlSubjPlan') : p.startsWith('/futures') ? `${t('moDerivVenue')}${name('account')}` : p === '/activity' ? t('activity') : p === '/security' ? t('security') : p === '/monitor' ? t('moTitle') : t('alTitle'); };
  const filtered = sev !== 'all' || group !== 'all';
  return <>
    <Seg label={t('alFilterSeverity')} value={sev} onChange={setSev} options={[['all', t('alAll')], ['critical', t('alSevCritical')], ['warning', t('alSevWarning')], ['info', t('alSevInfo')]] as const} />
    <Chips label={t('alFilterKind')} value={group} onChange={setGroup} options={[{ id: 'all' as const, label: t('alAllKinds') }, ...GROUPS.map((g) => ({ id: g, label: t(groupKey(g)) }))]} />
    <div className="flex min-h-11 items-center justify-between gap-3 px-1 text-[13.5px] text-mute">
      <span data-testid="alerts-unread">{t('alUnreadCount', { n: q.data?.unread ?? 0 })}</span>
      <button className="press -mr-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 font-medium text-blue disabled:text-mute disabled:opacity-60" disabled={!q.data?.unread} onClick={() => void mark({ all: true })}><Icon n="check" className="h-4 w-4" />{t('alMarkAll')}</button></div>
    {q.isLoading ? <InboxSkeleton /> : q.isError && !q.data ? <ErrorState title={t('dzAlLoadFailed')} onRetry={() => void q.refetch()} offline={typeof navigator !== 'undefined' && navigator.onLine === false}>{t('dzAlLoadFailedBody')}</ErrorState>
      : items.length === 0 ? <EmptyState icon="bell" title={t('dzAlEmptyTitle')}>{filtered ? t('dzAlEmptyFiltered') : t('dzAlEmptyBody')}</EmptyState> :
      <div className="space-y-4" data-testid="alerts-list">{days.map((g) => <section key={g.key} aria-label={g.label}><h2 className="t-eyebrow mb-2 px-1">{g.label}</h2>
        <Card className="!p-0 overflow-hidden"><ul className="divide-y divide-line">{g.items.map((a) => { const text = renderAlert(a.kind, localizeAlertParams(a.params, locale), locale, true), unread = a.readAt === null;   // v8: known server reasons in French
          return <li key={a.id}>
            <button onClick={() => { if (unread) void mark({ ids: [a.id] }); open(alertPath(a.kind, a.subject as never)); }} data-kind={a.kind} data-unread={unread} className="row-press flex w-full items-start gap-3.5 px-4 py-3.5 text-left">
              <SevPlate s={a.severity} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2"><span className={`min-w-0 flex-1 text-[15px] leading-snug ${unread ? 'font-semibold' : 'font-medium'}`}>{text.title}</span>
                  <time dateTime={new Date(a.ts).toISOString()} title={when(new Date(a.ts), locale)} className="shrink-0 text-xs text-mute">{rel(a.ts)}</time></span>
                {text.body && <span className={`mt-0.5 block break-words text-[13.5px] leading-snug ${unread ? 'text-ink/85' : 'text-mute'}`}>{text.body}</span>}
                <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-mute"><SevWord s={a.severity} />
                  {a.count > 1 && <Tag>×{a.count}</Tag>}
                  <span className="inline-flex min-w-0 items-center gap-1 font-medium text-blue">{a.subject?.network && <NetworkIcon net={a.subject.network} size={15} />}<span className="min-w-0 break-words">{subject(a)}</span><Icon n="chev" className="h-3 w-3 shrink-0" /></span>
                  {a.delivery === 'quiet' ? <span>{t('alDeliveryQuiet')}</span> : a.delivery === 'capped' ? <span>{t('alDeliveryCapped')}</span> : null}</span>
              </span>
              <span className="flex w-2.5 shrink-0 justify-end pt-1.5">{unread && <><span className="h-2.5 w-2.5 rounded-full bg-blue" aria-hidden="true" /><span className="sr-only">{t('alUnread')}</span></>}</span>
            </button></li>; })}</ul></Card></section>)}</div>}
    {items.length >= limit && <Btn kind="soft" full onClick={() => setLimit(limit + 40)}>{t('alMore')}</Btn>}
  </>;
}

/** one setting: label (and hint) on the left, its control on the right; rows of a card are separated by hairlines */
function Row({ label, hint, children, lead }: { label: ReactNode; hint?: ReactNode; children: ReactNode; lead?: ReactNode }) {
  return <div className="flex min-h-[52px] items-center gap-3 py-2">{lead}<span className="min-w-0 flex-1"><span className="block text-[15px] leading-snug">{label}</span>{hint && <span className="mt-0.5 block text-[12.5px] leading-snug text-mute">{hint}</span>}</span>{children}</div>;
}

function AlertSettings() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alert-settings'], queryFn: () => get<SettingsView>('/alerts/settings'), staleTime: 10_000 });
  const [err, setErr] = useState(''), [openGroup, setOpenGroup] = useState<AlertGroup | null>(null);
  const save = async (patch: Partial<SettingsT> | Record<string, unknown>) => { setErr(''); try { qc.setQueryData(['alert-settings'], await api<SettingsView>('PUT', '/alerts/settings', patch)); } catch (e) { setErr(errText(t, e)); } };
  if (!q.data) return q.isError ? <ErrorState title={t('dzAlLoadFailed')} onRetry={() => void q.refetch()}>{t('dzAlLoadFailedBody')}</ErrorState> : <div className="space-y-4"><SkeletonCard lines={3} /><SkeletonCard lines={2} /><SkeletonCard lines={4} /></div>;
  const s = q.data.settings, def = new Map<string, AlertDef>(ALERT_DEFS.map((d) => [d.kind, d]));
  const preview = renderAlert('transfer.confirmed', { amount: '25', symbol: 'USDC', network: 'Base' }, locale, s.showDetails);
  return <>
    {err && <Notice tone="danger">{err}</Notice>}
    <PushCard />
    <Section title={t('alPrivacy')}><Card className="!py-3">
      <Row label={t('alShowDetails')} hint={t('alShowDetailsHint')}><Toggle label={t('alShowDetails')} on={s.showDetails} onChange={(v) => void save({ showDetails: v })} /></Row>
      <div className="mb-2 mt-2"><div className="mb-1.5 text-xs text-mute">{t('alPreview')}</div>
        <div className="flex items-start gap-3 rounded-2xl bg-elev p-3" data-testid="push-preview"><img src="/icon.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-[10px]" />
          <div className="min-w-0 text-[13.5px] leading-snug"><div className="font-semibold">{preview.title}</div><div className="break-words">{preview.body}</div></div></div></div>
    </Card></Section>
    <Section title={t('alQuiet')}><Card className="!py-3">
      <Row label={t('alQuietOn')} hint={t('alQuietHint')}><Toggle label={t('alQuietOn')} on={s.quiet.enabled} onChange={(v) => void save({ quiet: { enabled: v } })} /></Row>
      <div className="space-y-3.5 border-t border-line py-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('alQuietFrom')}><input type="time" className={inputCls} value={s.quiet.start} onChange={(e) => e.target.value && void save({ quiet: { start: e.target.value } })} /></Field>
          <Field label={t('alQuietTo')}><input type="time" className={inputCls} value={s.quiet.end} onChange={(e) => e.target.value && void save({ quiet: { end: e.target.value } })} /></Field></div>
        <TextSetting label={t('alTimezone')} value={s.quiet.tz} onSave={(v) => save({ quiet: { tz: v } })} /></div>
      <div className="border-t border-line"><NumberSetting label={t('alCap')} hint={t('alCapHint')} value={s.capPerHour} min={1} max={500} onSave={(v) => save({ capPerHour: v })} /></div>
    </Card></Section>
    <Section title={t('alRules')}><Card className="!py-2">
      <p className="pb-2 pt-2 text-[13px] leading-snug text-mute">{t('alRulesHint')}</p>
      <ul className="divide-y divide-line border-t border-line">{GROUPS.map((g) => { const all = q.data.kinds.filter((k) => k.group === g), kinds = all.filter((k) => !k.fixed), on = kinds.filter((k) => s.rules[k.kind] !== false).length, isOpen = openGroup === g;
        return <li key={g}>
          <button className="flex min-h-[52px] w-full items-center justify-between gap-3 text-left" aria-expanded={isOpen} onClick={() => setOpenGroup(isOpen ? null : g)}>
            <span className="text-[15px] font-semibold">{t(groupKey(g))}</span><span className="flex items-center gap-2 text-[13px] text-mute">{on}/{kinds.length}<Icon n="chev" className={`h-4 w-4 transition ${isOpen ? 'rotate-90' : ''}`} /></span></button>
          {isOpen && <ul className="pb-2">{all.map((k) => { const d = def.get(k.kind), title = d ? d.title[locale === 'fr' ? 0 : 1] : k.kind;
            return <li key={k.kind} className="flex min-h-[52px] items-center gap-3 py-1.5" data-kind={k.kind} data-fixed={k.fixed || undefined}>
              <SevPlate s={k.severity} size="h-8 w-8" />
              <span className="min-w-0 flex-1"><span className="block text-[14.5px] leading-snug">{title}</span><span className="mt-0.5 block text-xs text-mute">{t((SEV[k.severity] ?? SEV.info!).key)}</span></span>
              {k.fixed ? <Tag tone="ok" icon="lock">{t('dzAlFixed')}</Tag> : <Toggle label={title} on={s.rules[k.kind] !== false} onChange={(v) => void save({ rules: { [k.kind]: v } })} />}</li>; })}</ul>}
        </li>; })}</ul>
    </Card></Section>
    <Section title={t('alThresholds')}><Card className="!py-2"><div className="divide-y divide-line">
      {([['stuckMinutes', 5, 1440], ['bridgeStuckMinutes', 10, 2880], ['agentDigestMinutes', 0, 1440], ['staleBars', 1, 100], ['signalFailures', 1, 50], ['fundingUsd', 0, 1_000_000], ['feedDebounceSec', 30, 3600], ['diskFreePct', 1, 50], ['backupHours', 1, 720]] as const).map(([k, min, max]) =>
        <NumberSetting key={k} label={t(`alTh_${k}` as Key)} value={s.thresholds[k] ?? 0} min={min} max={max} onSave={(v) => save({ thresholds: { [k]: v } })} />)}</div>
    </Card></Section>
    <WebhookCard view={q.data} save={save} />
  </>;
}

function NumberSetting({ label, hint, value, min, max, onSave }: { label: string; hint?: string; value: number; min: number; max: number; onSave: (v: number) => Promise<void> }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v), ok = v.trim() !== '' && Number.isFinite(n) && n >= min && n <= max;
  return <Row label={label} hint={hint}><input inputMode="decimal" aria-label={label} aria-invalid={!ok} className={`h-11 w-[88px] shrink-0 rounded-xl border bg-elev/60 px-3 text-right font-medium outline-none transition focus:border-blue focus:bg-surface focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--blue)_16%,transparent)] ${ok ? 'border-line' : 'border-danger'}`}
    value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (ok && n !== value) void onSave(n); else if (!ok) setV(String(value)); }} /></Row>;
}
function TextSetting({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <Field label={label}><input className={inputCls} value={v} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() && v !== value) void onSave(v.trim()).then(() => setV((x) => x)); }} /></Field>;
}

/** the state of push on this device: an icon plate, the state in words, what it means */
function PushStatus({ tone, icon, title, children }: { tone: 'ok' | 'warn' | 'info' | 'mute'; icon: string; title: string; children?: ReactNode }) {
  const c = { ok: 'bg-emerald/12 text-emerald', warn: 'bg-warn/12 text-warn', info: 'bg-blue/10 text-blue', mute: 'bg-elev text-mute' }[tone];
  return <div className="flex items-start gap-3.5"><span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${c}`} aria-hidden="true"><Icon n={icon} /></span>
    <div className="min-w-0 flex-1 pt-0.5"><div className={`text-[15.5px] font-semibold leading-snug ${tone === 'ok' ? 'text-emerald' : ''}`}>{title}</div>{children && <div className="mt-1 text-[13.5px] leading-snug text-mute">{children}</div>}</div></div>;
}

/** Web Push on this device: says plainly what is possible here (an iPhone must have the app on its Home Screen), then the devices. */
function PushCard() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['push-devices'], queryFn: () => get<Device[]>('/push/subscriptions') });
  const [state, setState] = useState<PushState | null>(null), [mine, setMine] = useState<string | null>(null), [busy, setBusy] = useState(''), [msg, setMsg] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string } | null>(null);
  const [label, setLabel] = useState(defaultLabel);
  const refresh = async () => { setState(await pushState()); const d = await qc.fetchQuery({ queryKey: ['push-devices'], queryFn: () => get<Device[]>('/push/subscriptions'), staleTime: 0 }); setMine((await thisDevice(d))?.id ?? null); };
  useEffect(() => { void refresh().catch(() => setState('unsupported')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (name: string, fn: () => Promise<void>) => { setBusy(name); setMsg(null); try { await fn(); } catch (e) { const c = (e as { code?: string }).code;
    setMsg({ tone: 'danger', text: c === 'push_denied' ? t('alPushDenied') : c === 'push_unsupported' ? t('alPushUnsupported') : errText(t, e) || t('alPushFailed') }); } finally { setBusy(''); await refresh().catch(() => {}); } };
  const test = (id?: string) => run(`test${id ?? ''}`, async () => {
    const r = await post<{ results: { ok: boolean; removed: boolean; error: string | null }[] }>('/push/test', id ? { id } : {});
    const ok = r.results.filter((x) => x.ok).length, removed = r.results.filter((x) => x.removed).length;
    setMsg(ok === r.results.length ? { tone: 'ok', text: t('alTestSent', { n: ok }) } : { tone: 'warn', text: removed ? t('alTestExpired') : `${t('alTestFailed')} ${r.results.find((x) => !x.ok)?.error ?? ''}` });
  });
  return <Section title={t('alPush')}><Card className="space-y-4">
    <div data-testid="push-state" data-state={state ?? 'loading'}>
      {state === null && <div className="flex items-center gap-3.5" aria-hidden="true"><div className="skel h-11 w-11 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-3.5 w-40 !rounded-md" /><div className="skel h-3 w-56 max-w-full !rounded-md" /></div></div>}
      {state === 'ios-install' && <PushStatus tone="info" icon="share" title={t('alIosTitle')}>
        <ol className="mt-2 space-y-2">{(['alIos1', 'alIos2', 'alIos3', 'alIos4'] as const).map((k, i) => <li key={k} className="flex gap-2.5 text-ink"><span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-elev text-[11.5px] font-semibold text-mute" aria-hidden="true">{i + 1}</span><span className="min-w-0">{t(k)}</span></li>)}</ol>
        <p className="mt-2.5">{t('alIosNote')}</p></PushStatus>}
      {state === 'unsupported' && <PushStatus tone="mute" icon="cloudOff" title={t('dzAlPushStUnsupported')}>{t('alPushUnsupported')}{isIos() ? ` ${t('alIosNote')}` : ''}</PushStatus>}
      {state === 'denied' && <div className="space-y-4"><PushStatus tone="warn" icon="warn" title={t('dzAlPushStDenied')}>{t('alPushDenied')}</PushStatus>
        <Btn kind="soft" full busy={busy === 'recheck'} onClick={() => void run('recheck', async () => {})}><Icon n="refresh" className="h-4 w-4" />{t('dzAlPushRecheck')}</Btn></div>}
      {state === 'off' && <div className="space-y-4"><PushStatus tone="mute" icon="bell" title={t('dzAlPushStOff')}>{t('alPushOffHint')}{isIos() ? ` ${t('alIosNote')}` : ''}</PushStatus>
        <Field label={t('alDeviceLabel')}><input className={inputCls} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Btn full busy={busy === 'enable'} onClick={() => void run('enable', async () => { await enablePush(label.trim() || defaultLabel(), locale); setMsg({ tone: 'ok', text: t('alPushEnabled') }); })}><Icon n="bell" className="h-[18px] w-[18px]" />{t('alPushEnable')}</Btn></div>}
      {state === 'on' && <PushStatus tone="ok" icon="check" title={t('alPushOn')}>{t('dzAlPushOnHint')}</PushStatus>}
    </div>
    {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    {(devices.data?.length ?? 0) > 0 && <div><div className="t-eyebrow mb-1">{t('dzAlDevices')}</div><ul className="divide-y divide-line" data-testid="push-devices">{devices.data!.map((d) => <li key={d.id} className="space-y-2.5 py-3">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words text-[15px] font-semibold">{d.label || d.service}</span>{d.id === mine && <Tag tone="ok" icon="check">{t('alThisDevice')}</Tag>}</div>
        <div className="mt-0.5 break-words text-[12.5px] text-mute">{d.service} · {d.lastOkAt ? `${t('alLastOk')} ${when(new Date(d.lastOkAt), locale)}` : t('alNeverSent')}{d.failures > 0 ? ` · ${t('alFailures', { n: d.failures })}` : ''}</div></div>
      <div className="grid grid-cols-2 gap-2"><Btn kind="soft" className="!min-h-11 !text-[14px]" busy={busy === `test${d.id}`} onClick={() => void test(d.id)}>{t('alTest')}</Btn>
        <Btn kind="ghost" className="!min-h-11 !text-[14px]" busy={busy === `rm${d.id}`} onClick={() => void run(`rm${d.id}`, async () => { if (d.id === mine) await disablePush(devices.data!); else await api('DELETE', `/push/subscriptions/${d.id}`); })}>{t('alRemove')}</Btn></div>
    </li>)}</ul></div>}
    <p className="flex gap-2 border-t border-line pt-3.5 text-[12.5px] leading-snug text-mute"><Icon n="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{t('alPushNote')}</span></p>
  </Card></Section>;
}

function WebhookCard({ view, save }: { view: SettingsView; save: (p: Record<string, unknown>) => Promise<void> }) {
  const t = useT(); const qc = useQueryClient(); const w = view.settings.webhook;
  const [secret, setSecret] = useState(''), [busy, setBusy] = useState(''), [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  return <Section title={t('alWebhook')} right={<Tag tone={w.enabled ? 'ok' : 'mute'} icon={w.enabled ? 'check' : 'minus'}>{t(w.enabled ? 'hdCapOn' : 'hdCapOff')}</Tag>}><Card className="space-y-3.5">
    <p className="text-[13px] leading-snug text-mute">{t('alWebhookHint')}</p>
    <TextSetting label={t('alWebhookUrl')} value={w.url} onSave={(v) => save({ webhook: { url: v } })} />
    <div className="divide-y divide-line border-y border-line">
      <Row label={t('alWebhookSecret')} hint={view.webhook.secretSet ? t('alWebhookSecretSet') : t('alWebhookSecretNone')}>
        <Btn kind="soft" className="!min-h-11 shrink-0 !px-4 !text-[14px]" busy={busy === 'secret'} onClick={() => { setBusy('secret'); void post<{ secret: string }>('/alerts/webhook/secret').then((r) => { setSecret(r.secret); void qc.invalidateQueries({ queryKey: ['alert-settings'] }); }).finally(() => setBusy('')); }}>{view.webhook.secretSet ? t('alWebhookRotate') : t('alWebhookGenerate')}</Btn></Row>
      {secret && <div className="py-3"><Notice tone="warn"><div>{t('alWebhookSecretOnce')}</div><code className="mt-1 block break-all font-mono text-[12.5px]">{secret}</code></Notice></div>}
      <Row label={t('alWebhookDetails')} hint={t('alWebhookDetailsHint')}><Toggle label={t('alWebhookDetails')} on={w.details} onChange={(v) => void save({ webhook: { details: v } })} /></Row></div>
    <div><div className="mb-1.5 text-xs text-mute">{t('alWebhookSample')}</div><pre className="max-h-48 overflow-auto rounded-2xl bg-elev p-3 font-mono text-[11.5px] leading-snug" data-testid="webhook-sample">{JSON.stringify(view.webhookSample, null, 1)}</pre></div>
    <div className="border-t border-line pt-1"><Row label={t('alWebhookOn')} hint={t('alWebhookOnHint')}><Toggle label={t('alWebhookOn')} on={w.enabled} disabled={!w.enabled && (!w.url || !view.webhook.secretSet)} onChange={(v) => void save({ webhook: { enabled: v } })} /></Row></div>
    <Btn kind="soft" full disabled={!w.url || !view.webhook.secretSet} busy={busy === 'test'} onClick={() => { setBusy('test'); setRes(null); void post<{ ok: boolean; status: number; error: string | null }>('/alerts/webhook/test').then((r) => setRes({ ok: r.ok, text: r.ok ? t('alWebhookTestOk') : `${t('alWebhookTestKo')} ${r.error ?? r.status}` }), (e) => setRes({ ok: false, text: errText(t, e) })).finally(() => setBusy('')); }}>{t('alWebhookTest')}</Btn>
    {res && <Notice tone={res.ok ? 'ok' : 'danger'}>{res.text}</Notice>}
  </Card></Section>;
}
