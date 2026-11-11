import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { ALERT_DEFS, alertPath, renderAlert, type AlertDef, type AlertGroup } from '../../../../packages/core/src/alert-catalog';
import { api, get, post } from '../api';
import { defaultLabel, disablePush, enablePush, isIos, pushState, thisDevice, type AlertItem, type Device, type PushState, type Unread } from '../alerts';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Chips, H, Icon, inputCls, Notice, Skeleton, when } from '../ui';

interface SettingsT {
  rules: Record<string, boolean>; quiet: { enabled: boolean; start: string; end: string; tz: string }; showDetails: boolean; capPerHour: number;
  thresholds: Record<string, number>; webhook: { enabled: boolean; url: string; details: boolean };
}
interface SettingsView { settings: SettingsT; kinds: { kind: string; group: AlertGroup; severity: string; default: boolean; fixed: boolean }[]; webhook: { secretSet: boolean }; webhookSample: unknown }
const SEV: Record<string, { icon: string; cls: string; key: Key }> = {
  critical: { icon: 'stop', cls: 'text-danger bg-danger/10', key: 'alSevCritical' }, warning: { icon: 'warn', cls: 'text-warn bg-warn/12', key: 'alSevWarning' }, info: { icon: 'check', cls: 'text-blue bg-blue/10', key: 'alSevInfo' },
};
const GROUPS: AlertGroup[] = ['transfers', 'agents', 'derivatives', 'security', 'system'];
const groupKey = (g: string) => `alGroup_${g}` as Key;

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={`relative h-8 w-14 shrink-0 rounded-full transition disabled:opacity-45 ${on ? 'bg-emerald' : 'bg-line'}`}><span className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-all ${on ? 'left-7' : 'left-1'}`} /></button>;
}
/** severity is always an icon and a word, never a colour alone */
function SevPill({ s }: { s: string }) {
  const t = useT(), x = SEV[s] ?? SEV.info!;
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${x.cls}`}><Icon n={x.icon} className="h-3 w-3" />{t(x.key)}</span>;
}

export function Alerts({ view, open, setView }: { view: 'list' | 'settings'; open: (path: string) => void; setView: (v: 'list' | 'settings') => void }) {
  const t = useT();
  return (
    <div className="space-y-4" data-testid="alerts-screen">
      <h1 className="pt-2 text-[30px] font-semibold tracking-[-0.02em]">{t('alTitle')}</h1>
      <div role="tablist" aria-label={t('alTitle')} className="flex gap-1 rounded-2xl bg-elev p-1">{(['list', 'settings'] as const).map((v) =>
        <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`min-h-11 flex-1 rounded-xl px-3 text-[14px] font-semibold transition ${view === v ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(15,23,42,0.12)]' : 'text-mute'}`}>{t(v === 'list' ? 'alTabList' : 'alTabSettings')}</button>)}</div>
      {view === 'list' ? <AlertList open={open} /> : <AlertSettings />}
    </div>
  );
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
  return <>
    <Chips label={t('alFilterSeverity')} value={sev} onChange={setSev} options={[{ id: 'all', label: t('alAll') }, { id: 'critical', label: t('alSevCritical') }, { id: 'warning', label: t('alSevWarning') }, { id: 'info', label: t('alSevInfo') }]} />
    <Chips label={t('alFilterKind')} value={group} onChange={setGroup} options={[{ id: 'all' as const, label: t('alAllKinds') }, ...GROUPS.map((g) => ({ id: g, label: t(groupKey(g)) }))]} />
    <div className="flex items-center justify-between gap-3 text-[13.5px] text-mute">
      <span data-testid="alerts-unread">{t('alUnreadCount', { n: q.data?.unread ?? 0 })}</span>
      <button className="font-medium text-blue disabled:opacity-40" disabled={!q.data?.unread} onClick={() => void mark({ all: true })}>{t('alMarkAll')}</button></div>
    {q.isLoading ? <Skeleton h="h-40" /> : items.length === 0 ? <Card><p className="py-6 text-center text-[14.5px] text-mute">{t('alEmpty')}</p></Card> :
      <ul className="space-y-2.5" data-testid="alerts-list">{items.map((a) => { const text = renderAlert(a.kind, a.params, locale, true), unread = a.readAt === null;
        return <li key={a.id}>
          <button onClick={() => { if (unread) void mark({ ids: [a.id] }); open(alertPath(a.kind, a.subject as never)); }} data-kind={a.kind} data-unread={unread}
            className={`card flex w-full items-start gap-3 p-4 text-left ${unread ? '' : 'opacity-70'}`}>
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${unread ? 'bg-blue' : 'bg-transparent'}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2"><span className="text-[15px] font-semibold leading-tight">{text.title}</span><SevPill s={a.severity} />
                {a.count > 1 && <span className="rounded-full bg-elev px-2 py-0.5 text-[11.5px] font-semibold text-mute">×{a.count}</span>}</span>
              {text.body && <span className="mt-1 block break-words text-[13.5px] leading-snug text-ink/80">{text.body}</span>}
              <span className="mt-1.5 block text-xs text-mute">{when(new Date(a.ts), locale)} · {t(groupKey(a.group))}{unread ? ` · ${t('alUnread')}` : ''}
                {a.delivery === 'quiet' ? ` · ${t('alDeliveryQuiet')}` : a.delivery === 'capped' ? ` · ${t('alDeliveryCapped')}` : ''}</span>
            </span>
            <Icon n="chev" className="mt-1 h-4 w-4 shrink-0 text-mute" />
          </button></li>; })}</ul>}
    {items.length >= limit && <Btn kind="soft" full onClick={() => setLimit(limit + 40)}>{t('alMore')}</Btn>}
  </>;
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4"><span className="min-w-0"><span className="block text-[14.5px]">{label}</span>{hint && <span className="block text-xs text-mute">{hint}</span>}</span>{children}</div>;
}

function AlertSettings() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alert-settings'], queryFn: () => get<SettingsView>('/alerts/settings'), staleTime: 10_000 });
  const [err, setErr] = useState(''), [openGroup, setOpenGroup] = useState<AlertGroup | null>(null);
  const save = async (patch: Partial<SettingsT> | Record<string, unknown>) => { setErr(''); try { qc.setQueryData(['alert-settings'], await api<SettingsView>('PUT', '/alerts/settings', patch)); } catch (e) { setErr(errText(t, e)); } };
  if (!q.data) return <Skeleton h="h-60" />;
  const s = q.data.settings, def = new Map<string, AlertDef>(ALERT_DEFS.map((d) => [d.kind, d]));
  return <>
    {err && <Notice tone="danger">{err}</Notice>}
    <PushCard />
    <Card className="space-y-4"><H>{t('alPrivacy')}</H>
      <Row label={t('alShowDetails')} hint={t('alShowDetailsHint')}><Toggle label={t('alShowDetails')} on={s.showDetails} onChange={(v) => void save({ showDetails: v })} /></Row>
      <div className="rounded-2xl bg-elev p-3 text-[13px] leading-snug" data-testid="push-preview"><div className="text-xs text-mute">{t('alPreview')}</div>
        {(() => { const x = renderAlert('transfer.confirmed', { amount: '25', symbol: 'USDC', network: 'Base' }, locale, s.showDetails); return <><div className="mt-1 font-semibold">{x.title}</div><div>{x.body}</div></>; })()}</div>
    </Card>
    <Card className="space-y-4"><H>{t('alQuiet')}</H>
      <Row label={t('alQuietOn')} hint={t('alQuietHint')}><Toggle label={t('alQuietOn')} on={s.quiet.enabled} onChange={(v) => void save({ quiet: { enabled: v } })} /></Row>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-[13px] text-mute">{t('alQuietFrom')}<input type="time" className={`${inputCls} mt-1`} value={s.quiet.start} onChange={(e) => e.target.value && void save({ quiet: { start: e.target.value } })} /></label>
        <label className="block text-[13px] text-mute">{t('alQuietTo')}<input type="time" className={`${inputCls} mt-1`} value={s.quiet.end} onChange={(e) => e.target.value && void save({ quiet: { end: e.target.value } })} /></label></div>
      <TextSetting label={t('alTimezone')} value={s.quiet.tz} onSave={(v) => save({ quiet: { tz: v } })} />
      <NumberSetting label={t('alCap')} hint={t('alCapHint')} value={s.capPerHour} min={1} max={500} onSave={(v) => save({ capPerHour: v })} />
    </Card>
    <Card><H>{t('alRules')}</H>
      <p className="mb-3 text-[13px] text-mute">{t('alRulesHint')}</p>
      <ul className="divide-y divide-line">{GROUPS.map((g) => { const kinds = q.data.kinds.filter((k) => k.group === g && !k.fixed), on = kinds.filter((k) => s.rules[k.kind] !== false).length, isOpen = openGroup === g;
        return <li key={g} className="py-1">
          <button className="flex min-h-12 w-full items-center justify-between gap-3 text-left" aria-expanded={isOpen} onClick={() => setOpenGroup(isOpen ? null : g)}>
            <span className="text-[15px] font-semibold">{t(groupKey(g))}</span><span className="flex items-center gap-2 text-[13px] text-mute">{on}/{kinds.length}<Icon n="chev" className={`h-4 w-4 transition ${isOpen ? 'rotate-90' : ''}`} /></span></button>
          {isOpen && <ul className="space-y-3.5 pb-3 pt-1">{kinds.map((k) => { const d = def.get(k.kind)!;
            return <li key={k.kind} className="flex items-center justify-between gap-3">
              <span className="min-w-0"><span className="block text-[14.5px] leading-tight">{d.title[locale === 'fr' ? 0 : 1]}</span><span className="mt-1 block"><SevPill s={k.severity} /></span></span>
              <Toggle label={d.title[locale === 'fr' ? 0 : 1]} on={s.rules[k.kind] !== false} onChange={(v) => void save({ rules: { [k.kind]: v } })} /></li>; })}</ul>}
        </li>; })}</ul>
    </Card>
    <Card className="space-y-4"><H>{t('alThresholds')}</H>
      {([['stuckMinutes', 5, 1440], ['bridgeStuckMinutes', 10, 2880], ['agentDigestMinutes', 0, 1440], ['staleBars', 1, 100], ['signalFailures', 1, 50], ['fundingUsd', 0, 1_000_000], ['feedDebounceSec', 30, 3600], ['diskFreePct', 1, 50], ['backupHours', 1, 720]] as const).map(([k, min, max]) =>
        <NumberSetting key={k} label={t(`alTh_${k}` as Key)} value={s.thresholds[k] ?? 0} min={min} max={max} onSave={(v) => save({ thresholds: { [k]: v } })} />)}
    </Card>
    <WebhookCard view={q.data} save={save} />
  </>;
}

function NumberSetting({ label, hint, value, min, max, onSave }: { label: string; hint?: string; value: number; min: number; max: number; onSave: (v: number) => Promise<void> }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v), ok = v.trim() !== '' && Number.isFinite(n) && n >= min && n <= max;
  return <Row label={label} hint={hint}><input inputMode="decimal" aria-label={label} aria-invalid={!ok} className={`w-24 shrink-0 rounded-xl border bg-elev/60 px-3 py-2 text-right outline-none focus:border-blue ${ok ? 'border-line' : 'border-danger'}`}
    value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (ok && n !== value) void onSave(n); else if (!ok) setV(String(value)); }} /></Row>;
}
function TextSetting({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <label className="block text-[13px] text-mute">{label}<input className={`${inputCls} mt-1`} value={v} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() && v !== value) void onSave(v.trim()).then(() => setV((x) => x)); }} /></label>;
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
  return <Card className="space-y-4" ><H>{t('alPush')}</H>
    <div data-testid="push-state" data-state={state ?? 'loading'}>
      {state === 'ios-install' && <Notice tone="info"><b>{t('alIosTitle')}</b><ol className="mt-1.5 list-decimal space-y-1 pl-5"><li>{t('alIos1')}</li><li>{t('alIos2')}</li><li>{t('alIos3')}</li><li>{t('alIos4')}</li></ol><p className="mt-1.5">{t('alIosNote')}</p></Notice>}
      {state === 'unsupported' && <Notice tone="warn">{t('alPushUnsupported')}{isIos() ? ` ${t('alIosNote')}` : ''}</Notice>}
      {state === 'denied' && <Notice tone="warn">{t('alPushDenied')}</Notice>}
      {state === 'off' && <div className="space-y-3"><p className="text-[13.5px] text-mute">{t('alPushOffHint')}{isIos() ? ` ${t('alIosNote')}` : ''}</p>
        <label className="block text-[13px] text-mute">{t('alDeviceLabel')}<input className={`${inputCls} mt-1`} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></label>
        <Btn full busy={busy === 'enable'} onClick={() => void run('enable', async () => { await enablePush(label.trim() || defaultLabel(), locale); setMsg({ tone: 'ok', text: t('alPushEnabled') }); })}><Icon n="check" />{t('alPushEnable')}</Btn></div>}
      {state === 'on' && <div className="flex items-center gap-2 text-[15px] font-medium text-emerald"><Icon n="check" />{t('alPushOn')}</div>}
    </div>
    {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    {(devices.data?.length ?? 0) > 0 && <ul className="divide-y divide-line" data-testid="push-devices">{devices.data!.map((d) => <li key={d.id} className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-3"><span className="min-w-0"><span className="block truncate text-[14.5px] font-semibold">{d.label || d.service}{d.id === mine ? ` · ${t('alThisDevice')}` : ''}</span>
        <span className="block truncate text-xs text-mute">{d.service} · {d.lastOkAt ? `${t('alLastOk')} ${when(new Date(d.lastOkAt), locale)}` : t('alNeverSent')}{d.failures > 0 ? ` · ${t('alFailures', { n: d.failures })}` : ''}</span></span></div>
      <div className="grid grid-cols-2 gap-2"><Btn kind="soft" className="!min-h-11 !text-[14px]" busy={busy === `test${d.id}`} onClick={() => void test(d.id)}>{t('alTest')}</Btn>
        <Btn kind="ghost" className="!min-h-11 !text-[14px]" busy={busy === `rm${d.id}`} onClick={() => void run(`rm${d.id}`, async () => { if (d.id === mine) await disablePush(devices.data!); else await api('DELETE', `/push/subscriptions/${d.id}`); })}>{t('alRemove')}</Btn></div>
    </li>)}</ul>}
    <p className="text-[12.5px] text-mute">{t('alPushNote')}</p>
  </Card>;
}

function WebhookCard({ view, save }: { view: SettingsView; save: (p: Record<string, unknown>) => Promise<void> }) {
  const t = useT(); const qc = useQueryClient(); const w = view.settings.webhook;
  const [secret, setSecret] = useState(''), [busy, setBusy] = useState(''), [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  return <Card className="space-y-4"><H>{t('alWebhook')}</H>
    <p className="text-[13px] text-mute">{t('alWebhookHint')}</p>
    <TextSetting label={t('alWebhookUrl')} value={w.url} onSave={(v) => save({ webhook: { url: v } })} />
    <Row label={t('alWebhookSecret')} hint={view.webhook.secretSet ? t('alWebhookSecretSet') : t('alWebhookSecretNone')}>
      <Btn kind="soft" className="!min-h-11 shrink-0 !px-4 !text-[14px]" busy={busy === 'secret'} onClick={() => { setBusy('secret'); void post<{ secret: string }>('/alerts/webhook/secret').then((r) => { setSecret(r.secret); void qc.invalidateQueries({ queryKey: ['alert-settings'] }); }).finally(() => setBusy('')); }}>{view.webhook.secretSet ? t('alWebhookRotate') : t('alWebhookGenerate')}</Btn></Row>
    {secret && <Notice tone="warn"><div>{t('alWebhookSecretOnce')}</div><code className="mt-1 block break-all font-mono text-[12.5px]">{secret}</code></Notice>}
    <Row label={t('alWebhookDetails')} hint={t('alWebhookDetailsHint')}><Toggle label={t('alWebhookDetails')} on={w.details} onChange={(v) => void save({ webhook: { details: v } })} /></Row>
    <div><div className="text-xs text-mute">{t('alWebhookSample')}</div><pre className="mt-1 max-h-48 overflow-auto rounded-2xl bg-elev p-3 text-[11.5px] leading-snug" data-testid="webhook-sample">{JSON.stringify(view.webhookSample, null, 1)}</pre></div>
    <Row label={t('alWebhookOn')} hint={t('alWebhookOnHint')}><Toggle label={t('alWebhookOn')} on={w.enabled} disabled={!w.enabled && (!w.url || !view.webhook.secretSet)} onChange={(v) => void save({ webhook: { enabled: v } })} /></Row>
    <Btn kind="soft" full disabled={!w.url || !view.webhook.secretSet} busy={busy === 'test'} onClick={() => { setBusy('test'); setRes(null); void post<{ ok: boolean; status: number; error: string | null }>('/alerts/webhook/test').then((r) => setRes({ ok: r.ok, text: r.ok ? t('alWebhookTestOk') : `${t('alWebhookTestKo')} ${r.error ?? r.status}` }), (e) => setRes({ ok: false, text: errText(t, e) })).finally(() => setBusy('')); }}>{t('alWebhookTest')}</Btn>
    {res && <Notice tone={res.ok ? 'ok' : 'danger'}>{res.text}</Notice>}
  </Card>;
}
