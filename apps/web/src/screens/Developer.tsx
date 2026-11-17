// V11 — Developer / API: the owner's side of the SP Trading API (/api/v1/developer/*, owner session only).
// Keys (create with the passkey, secret shown once, revoke, rotate), usage and rate limits, webhooks, service status, and the
// documentation: the OpenAPI document served by the wallet itself, rendered here by a small viewer (no CDN: the CSP allows
// nothing but this origin), with Python and TypeScript examples. Pure parts: ../developer.ts.
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, get, post, type ApiError } from '../api';
import { codeExamples, daysLeft, docOps, docTags, draftBody, emptyDraft, errKey, SCOPE_GROUPS, scopeKey, type ApiKey, type DocOp, type DraftError, type KeyDraft, type KeysAnswer, type StatusAnswer, type UsageAnswer, type WebhooksAnswer } from '../developer';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Card, CopyBtn, EmptyState, ErrorState, Fact, Field, Fold, H, Icon, inputCls, Notice, PageTitle, Section, Seg, Sheet, SkeletonCard, SkeletonRows, Stat, StatGrid, Tag, Timeline, when, type Tone } from '../ui';
import { srvText } from '../srvText';
import { SHOWN_VENUES } from '../venues';

type View = 'keys' | 'usage' | 'webhooks' | 'docs' | 'status';
const VIEWS: View[] = ['keys', 'usage', 'webhooks', 'docs', 'status'];
const P = '/developer';
const STATUS_TONE: Record<ApiKey['status'], Tone> = { active: 'ok', expired: 'mute', revoked: 'danger' };
const STATUS_ICON: Record<ApiKey['status'], string> = { active: 'check', expired: 'clock', revoked: 'x' };

/** a sentence for an error of the developer routes; a cancelled passkey prompt says nothing */
function useErr() {
  const t = useT();
  return (e: unknown): string => { const x = e as ApiError & { name?: string }; if (x?.name === 'NotAllowedError') return ''; const k = errKey(x?.code); return k === 'dvErrOther' ? t('dvErrOther', { code: x?.code ?? 'error' }) : t(k as Key); };
}
const Code = ({ children, label }: { children: string; label: string }) =>
  <pre tabIndex={0} aria-label={label} className="max-h-80 overflow-auto rounded-2xl bg-elev p-3.5 font-mono text-[12px] leading-relaxed">{children}</pre>;
const Check = ({ on, onChange, children, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: ReactNode; disabled?: boolean }) =>
  <label className={`flex min-h-11 cursor-pointer items-start gap-3 py-1.5 ${disabled ? 'opacity-50' : ''}`}><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-[18px] w-[18px] shrink-0 accent-[var(--blue)]" />
    <span className="min-w-0"><span className="block text-[14.5px] font-medium">{children}</span>{hint && <span className="block text-xs text-mute">{hint}</span>}</span></label>;

export function Developer({ view, setView, onBack }: { view?: string; setView: (v: View) => void; onBack: () => void }) {
  const t = useT();
  const v: View = (VIEWS as string[]).includes(view ?? '') ? (view as View) : 'keys';
  return (
    <div className="space-y-4" data-testid="developer">
      <PageTitle onBack={onBack} backLabel={t('settings')}>{t('dvTitle')}</PageTitle>
      <p className="px-1 text-[14px] leading-snug text-mute">{t('dvLead')}</p>
      <div className="overflow-x-auto"><Seg role="tablist" label={t('dvTitle')} value={v} options={VIEWS.map((x) => [x, t(`dvTab_${x}` as Key)] as const)} onChange={setView} /></div>
      {v === 'keys' && <Keys />}
      {v === 'usage' && <Usage />}
      {v === 'webhooks' && <Webhooks />}
      {v === 'docs' && <Docs />}
      {v === 'status' && <Status />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- keys
function Keys() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient(); const err = useErr();
  const q = useQuery({ queryKey: ['dev', 'keys'], queryFn: () => get<KeysAnswer>(`${P}/keys`) });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; secret: string; id: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'rotate'; key: ApiKey } | null>(null);
  const [busy, setBusy] = useState(false); const [fail, setFail] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['dev'] }); };

  const act = async () => {
    if (!confirm) return;
    setBusy(true); setFail('');
    try {
      if (confirm.kind === 'revoke') await post(`${P}/keys/${confirm.key.id}/revoke`, {});
      else {
        const p = await post(`${P}/keys/${confirm.key.id}/rotate/prepare`, {});
        const assertion = await startAuthentication({ optionsJSON: p.options });   // the challenge is the fingerprint of this exact rotation
        const r = await post(`${P}/keys/${confirm.key.id}/rotate`, { intentId: p.intentId, assertion });
        setSecret({ title: t('dvRotatedTitle'), secret: r.secret, id: r.key.id });
      }
      setConfirm(null); refresh();
    } catch (e) { setFail(err(e)); } finally { setBusy(false); }
  };

  if (q.isLoading) return <SkeletonRows n={3} />;
  if (q.isError || !q.data) return <ErrorState title={t('dvLoadError')} onRetry={() => void q.refetch()} />;
  const d = q.data, now = Date.now();
  return (
    <div className="space-y-4">
      <Notice tone="warn"><b>{t('dvExecTitle')}</b> {t('dvExecNote')}</Notice>
      <Btn full onClick={() => setCreating(true)} data-testid="dev-new-key"><Icon n="plus" className="h-4 w-4" />{t('dvNewKey')}</Btn>
      {d.keys.length === 0 && <Card><EmptyState icon="key" title={t('dvNoKeys')}>{t('dvNoKeysBody')}</EmptyState></Card>}
      {d.keys.map((k) => (
        <Card key={k.id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2" data-testid={`dev-key-${k.id}`}>
            <div className="min-w-0"><h2 className="break-words text-[16.5px] font-semibold">{k.name}</h2><p className="font-mono text-[12.5px] text-mute">{k.id}</p></div>
            <Tag tone={STATUS_TONE[k.status]} icon={STATUS_ICON[k.status]}>{t(`dvStatus_${k.status}` as Key)}</Tag>
          </div>
          <ul className="flex flex-wrap gap-1.5" aria-label={t('dvScopes')}>{k.scopes.map((s) => <li key={s}><Tag tone={k.inertScopes.includes(s) ? 'warn' : 'info'} icon={k.inertScopes.includes(s) ? 'lock' : undefined}>{s}{k.inertScopes.includes(s) ? ` · ${t('dvInert')}` : ''}</Tag></li>)}</ul>
          <dl>
            <Fact k={t('dvExpiresK')}>{when(new Date(k.expiresAt), locale)}{k.status === 'active' ? ` · ${t('dvDaysLeft', { n: daysLeft(k.expiresAt, now) })}` : ''}</Fact>
            <Fact k={t('dvLastUsedK')}>{k.lastUsedAt ? when(new Date(k.lastUsedAt), locale) : t('dvNeverUsed')}</Fact>
            <Fact k={t('dvRateK')}>{t('dvRate', { n: k.rateLimitPerMin })}</Fact>
            <Fact k={t('dvLimitsK')}>{k.limits.maxOrderNotionalUsd === null && k.limits.maxDailyNotionalUsd === null ? t('dvNoLimit')
              : `${t('dvLimitOrder')} ${k.limits.maxOrderNotionalUsd ?? '—'} USD · ${t('dvLimitDaily')} ${k.limits.maxDailyNotionalUsd ?? '—'} USD`}</Fact>
            <Fact k={t('dvRestrictionsK')}>{(['venues', 'instruments', 'networks', 'ipAllow'] as const).every((a) => k.restrictions[a].length === 0) ? t('dvRestrNone')
              : (['venues', 'instruments', 'networks', 'ipAllow'] as const).filter((a) => k.restrictions[a].length).map((a) => `${t(`dvAxis_${a}` as Key)} : ${k.restrictions[a].join(', ')}`).join(' · ')}</Fact>
            <Fact k={t('dvMandateK')} mono={!!k.mandateId}>{k.mandateId ?? t('dvMandateNone')}</Fact>
            {k.revokedAt && <Fact k={t('dvRevokedK')}>{when(new Date(k.revokedAt), locale)}{k.revokedReason ? ` · ${k.revokedReason}` : ''}</Fact>}
          </dl>
          {k.status === 'active' && <div className="grid grid-cols-2 gap-2.5">
            <Btn kind="soft" onClick={() => { setFail(''); setConfirm({ kind: 'rotate', key: k }); }}><Icon n="refresh" className="h-4 w-4" />{t('dvRotate')}</Btn>
            <Btn kind="ghost" className="!text-danger" onClick={() => { setFail(''); setConfirm({ kind: 'revoke', key: k }); }}><Icon n="stop" className="h-4 w-4" />{t('dvRevoke')}</Btn></div>}
        </Card>))}
      {creating && <CreateKey data={d} onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); refresh(); }} />}
      {confirm && <Sheet title={t(confirm.kind === 'revoke' ? 'dvRevokeTitle' : 'dvRotateTitle')} sub={confirm.key.name} onClose={() => setConfirm(null)} busy={busy} testid="dev-confirm"
        footer={<Btn full kind={confirm.kind === 'revoke' ? 'danger' : 'primary'} busy={busy} onClick={() => void act()}>{confirm.kind === 'revoke' ? t('dvRevokeConfirm') : t('approve')}</Btn>}>
        <div className="space-y-3"><p className="text-[14.5px] leading-snug">{t(confirm.kind === 'revoke' ? 'dvRevokeBody' : 'dvRotateBody')}</p>{fail && <Notice tone="danger">{fail}</Notice>}</div></Sheet>}
      {secret && <Sheet title={secret.title} sub={secret.id} onClose={() => setSecret(null)} dismissable={false} testid="dev-secret"
        footer={<Btn full onClick={() => setSecret(null)}>{t('dvSecretSaved')}</Btn>}>
        <div className="space-y-3"><Notice tone="warn">{t('dvSecretOnce')}</Notice>
          <p className="break-all rounded-2xl bg-elev p-3.5 font-mono text-[13px] leading-relaxed" data-testid="dev-secret-value" aria-label={t('dvSecretLabel')}>{secret.secret}</p>
          <CopyBtn text={secret.secret} full /></div></Sheet>}
    </div>
  );
}

function CreateKey({ data, onClose, onCreated }: { data: KeysAnswer; onClose: () => void; onCreated: (s: { title: string; secret: string; id: string }) => void }) {
  const t = useT(); const err = useErr();
  const [d, setD] = useState<KeyDraft>(() => emptyDraft(data.bounds.defaultRatePerMin));
  const [errors, setErrors] = useState<DraftError[]>([]); const [fail, setFail] = useState(''); const [busy, setBusy] = useState(false);
  const set = <K extends keyof KeyDraft>(k: K, v: KeyDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const known = new Set(data.scopes.map((s) => s.scope));
  const bad = (e: DraftError) => (errors.includes(e) ? <span className="text-danger">{t(`dvFieldErr_${e}` as Key)}</span> : undefined);
  const submit = async () => {
    const b = draftBody(d, data.bounds);
    if (!b.ok) { setErrors(b.errors); return; }
    setErrors([]); setFail(''); setBusy(true);
    try {
      const p = await post(`${P}/keys/prepare`, b.body);
      const assertion = await startAuthentication({ optionsJSON: p.options });   // the passkey signs the SHA-256 of the canonical request the server just showed
      const r = await post(`${P}/keys`, { intentId: p.intentId, assertion });
      onCreated({ title: t('dvSecretTitle'), secret: r.secret, id: r.key.id });
    } catch (e) { setFail(err(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t('dvCreateTitle')} onClose={onClose} wide busy={busy} testid="dev-create" footer={<Btn full busy={busy} onClick={() => void submit()} data-testid="dev-create-submit"><Icon n="key" className="h-4 w-4" />{t('approve')}</Btn>}>
      <div className="space-y-5">
        <Field label={t('dvName')} hint={bad('name')}><input className={inputCls} value={d.name} maxLength={60} placeholder={t('dvNamePh')} onChange={(e) => set('name', e.target.value)} data-testid="dev-name" /></Field>
        <div><span className="mb-1.5 block text-[13px] font-medium text-mute">{t('dvExpiry')}</span>
          <Seg label={t('dvExpiry')} value={String(d.days)} options={[7, 30, 90, 365].filter((n) => n <= data.bounds.maxDays).map((n) => [String(n), t('dvDays', { n })] as const)} onChange={(x) => set('days', Number(x))} /></div>
        <fieldset><legend className="mb-1 text-[13px] font-medium text-mute">{t('dvScopes')}</legend>{bad('scopes')}
          {SCOPE_GROUPS.map((g) => <div key={g.id} className="mb-2"><p className="t-eyebrow mb-0.5 mt-2">{t(`dvGroup_${g.id}` as Key)}</p>
            {g.id === 'execute' && <p className="mb-1 text-xs leading-snug text-warn">{t('dvGroupExecuteNote')}</p>}
            {g.scopes.filter((s) => known.has(s)).map((s) => <Check key={s} on={d.scopes.includes(s)} onChange={(on) => set('scopes', on ? [...d.scopes, s] : d.scopes.filter((x) => x !== s))} hint={<span className="font-mono">{s}</span>}>{t(scopeKey(s) as Key)}</Check>)}</div>)}</fieldset>
        <Field label={t('dvRateLabel')} hint={bad('rate') ?? t('dvRateHint', { max: data.bounds.maxRatePerMin })}><input className={inputCls} inputMode="numeric" value={d.ratePerMin} onChange={(e) => set('ratePerMin', e.target.value)} /></Field>
        <Fold summary={t('dvLimitsK')}>
          <div className="space-y-3"><p className="text-xs leading-snug text-mute">{t('dvLimitsNote')}</p>
            <Field label={`${t('dvLimitOrder')} (USD)`} hint={bad('maxOrder')}><input className={inputCls} inputMode="decimal" value={d.maxOrderUsd} placeholder={t('dvNoLimit')} onChange={(e) => set('maxOrderUsd', e.target.value)} /></Field>
            <Field label={`${t('dvLimitDaily')} (USD)`} hint={bad('maxDaily')}><input className={inputCls} inputMode="decimal" value={d.maxDailyUsd} placeholder={t('dvNoLimit')} onChange={(e) => set('maxDailyUsd', e.target.value)} /></Field></div></Fold>
        <Fold summary={t('dvRestrictionsK')}>
          <div className="space-y-3"><p className="text-xs leading-snug text-mute">{t('dvRestrNote')}</p>
            <Field label={t('dvAxis_venues')}><input className={inputCls} value={d.venues} placeholder={`${SHOWN_VENUES.join(', ')}, spot`} onChange={(e) => set('venues', e.target.value)} /></Field>
            <Field label={t('dvAxis_instruments')}><input className={inputCls} value={d.instruments} placeholder="hyperliquid:BTC, hyperliquid:ETH" onChange={(e) => set('instruments', e.target.value)} /></Field>
            <Field label={t('dvAxis_networks')}><input className={inputCls} value={d.networks} placeholder="base, arbitrum" onChange={(e) => set('networks', e.target.value)} /></Field>
            <Field label={t('dvAxis_ipAllow')} hint={bad('ips')}><input className={inputCls} value={d.ips} placeholder="203.0.113.7, 10.0.0.0/8" onChange={(e) => set('ips', e.target.value)} /></Field></div></Fold>
        <Fold summary={t('dvMandateK')}>
          <Field label={t('dvMandateId')} hint={bad('mandate') ?? t('dvMandateHint')}><input className={`${inputCls} font-mono text-[13px]`} value={d.mandateId} placeholder="00000000-0000-4000-8000-000000000000" onChange={(e) => set('mandateId', e.target.value)} /></Field></Fold>
        <Notice>{t('dvCreateNote')}</Notice>
        {fail && <Notice tone="danger">{fail}</Notice>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------- usage
function Usage() {
  const t = useT(); const { locale } = useContext(I18n);
  const keys = useQuery({ queryKey: ['dev', 'keys'], queryFn: () => get<KeysAnswer>(`${P}/keys`) });
  const [key, setKey] = useState('');
  const q = useQuery({ queryKey: ['dev', 'usage', key], queryFn: () => get<UsageAnswer>(`${P}/usage?limit=100${key ? `&key=${key}` : ''}`), refetchInterval: 15_000 });
  if (q.isLoading) return <SkeletonRows n={4} />;
  if (q.isError || !q.data) return <ErrorState title={t('dvLoadError')} onRetry={() => void q.refetch()} />;
  const name = (id: string) => keys.data?.keys.find((k) => k.id === id)?.name ?? id;
  const rows = q.data.perKey.filter((r) => !key || r.keyId === key);
  return (
    <div className="space-y-4">
      <Field label={t('dvUsageKey')}><select className={inputCls} value={key} onChange={(e) => setKey(e.target.value)}><option value="">{t('dvAllKeys')}</option>{(keys.data?.keys ?? []).map((k) => <option key={k.id} value={k.id}>{k.name} · {k.id}</option>)}</select></Field>
      {rows.length === 0 && <Card><EmptyState icon="bars" title={t('dvUsageEmpty')}>{t('dvUsageEmptyBody')}</EmptyState></Card>}
      {rows.map((r) => { const limit = keys.data?.keys.find((k) => k.id === r.keyId)?.rateLimitPerMin; return (
        <Section key={r.keyId} title={name(r.keyId)}>
          <StatGrid cols={4}>
            <Stat label={t('dvCalls24h')} value={r.calls24h} />
            <Stat label={t('dvErrors24h')} value={r.errors24h} tone={r.errors24h ? 'warn' : undefined} />
            <Stat label={t('dvLimited24h')} value={r.rateLimited24h} tone={r.rateLimited24h ? 'danger' : undefined} />
            <Stat label={t('dvLastMinute')} value={limit ? `${r.callsLastMinute} / ${limit}` : r.callsLastMinute} sub={r.p95Ms !== null ? t('dvP95', { n: r.p95Ms }) : undefined} />
          </StatGrid></Section>); })}
      {q.data.items.length > 0 && <Card><H>{t('dvRecentCalls')}</H>
        <ul className="divide-y divide-line text-[13px]">{q.data.items.map((u) => <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
          <Tag tone={u.status < 400 ? 'ok' : u.status === 429 ? 'warn' : 'danger'} icon={u.status < 400 ? 'check' : 'warn'}>{u.status}</Tag>
          <span className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{u.method} {u.route}</span>
          <span className="text-xs text-mute">{u.latencyMs} ms · {when(new Date(u.ts), locale)}{key ? '' : ` · ${name(u.keyId)}`}</span></li>)}</ul></Card>}
      <p className="px-1 text-xs text-mute">{t('dvRetention', { n: q.data.retentionDays })}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- webhooks
function Webhooks() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient(); const err = useErr();
  const q = useQuery({ queryKey: ['dev', 'webhooks'], queryFn: () => get<WebhooksAnswer>(`${P}/webhooks`), refetchInterval: 20_000 });
  const [adding, setAdding] = useState(false); const [url, setUrl] = useState(''); const [label, setLabel] = useState(''); const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null); const [busy, setBusy] = useState(false); const [fail, setFail] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['dev', 'webhooks'] });
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setFail(''); try { await f(); await refresh(); } catch (e) { setFail(err(e)); } finally { setBusy(false); } };
  if (q.isLoading) return <SkeletonRows n={3} />;
  if (q.isError || !q.data) return <ErrorState title={t('dvLoadError')} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <Btn full onClick={() => { setAdding(true); setFail(''); setUrl(''); setLabel(''); setEvents(d.events.filter((e) => e.emitted).map((e) => e.event)); }}><Icon n="plus" className="h-4 w-4" />{t('dvHookNew')}</Btn>
      {fail && !adding && <Notice tone="danger">{fail}</Notice>}
      {d.webhooks.length === 0 && <Card><EmptyState icon="bolt" title={t('dvHookNone')}>{t('dvHookNoneBody')}</EmptyState></Card>}
      {d.webhooks.map((w) => <Card key={w.id} className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h2 className="break-all text-[15px] font-semibold">{w.label || new URL(w.url).host}</h2><p className="break-all font-mono text-[12px] text-mute">{w.url}</p></div>
          <Tag tone={!w.enabled ? 'mute' : w.failures ? 'warn' : 'ok'} icon={!w.enabled ? 'minus' : w.failures ? 'warn' : 'check'}>{t(w.enabled ? 'dvHookEnabled' : 'dvHookDisabled')}</Tag></div>
        <ul className="flex flex-wrap gap-1.5" aria-label={t('dvHookEvents')}>{w.events.map((e) => <li key={e}><Tag tone="info">{e}</Tag></li>)}</ul>
        <dl><Fact k={t('dvHookLastOk')}>{w.lastOkAt ? when(new Date(w.lastOkAt), locale) : t('dvNeverUsed')}</Fact>
          {w.failures > 0 && <Fact k={t('dvHookFailures')}>{w.failures}{w.lastError ? ` · ${w.lastError}` : ''}</Fact>}</dl>
        <div className="grid grid-cols-2 gap-2.5">
          <Btn kind="soft" busy={busy} onClick={() => void run(() => post(`${P}/webhooks/${w.id}`, { enabled: !w.enabled }, { 'idempotency-key': crypto.randomUUID() }))}>{t(w.enabled ? 'dvHookDisable' : 'dvHookEnable')}</Btn>
          <Btn kind="soft" busy={busy} onClick={() => void run(async () => { const r = await post(`${P}/webhooks/${w.id}/secret`, {}); setSecret({ id: w.id, secret: r.secret }); })}>{t('dvHookNewSecret')}</Btn>
          <Btn kind="ghost" className="col-span-2 !text-danger" busy={busy} onClick={() => void run(() => api('DELETE', `${P}/webhooks/${w.id}`))}>{t('dvHookDelete')}</Btn></div>
      </Card>)}
      <Card><H>{t('dvHookEvents')}</H>
        <ul className="space-y-3 text-[13.5px]">{d.events.map((e) => <li key={e.event}><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[13px] font-semibold">{e.event}</span>
          <Tag tone={e.emitted ? 'ok' : 'mute'} icon={e.emitted ? 'check' : 'clock'}>{t(e.emitted ? 'dvEvEmitted' : 'dvEvPending')}</Tag></div>
          <p className="mt-0.5 break-words font-mono text-[12px] text-mute">{e.payload}</p></li>)}</ul>
        <p className="mt-3 break-words text-xs leading-snug text-mute">{t('dvSignature')} <span className="font-mono">{d.signature}</span></p>
        <p className="mt-1 text-xs leading-snug text-mute">{t('dvRetryPolicy', { n: d.retry.attempts, steps: d.retry.backoffSec.map((s) => (s >= 3600 ? `${s / 3600} h` : s >= 60 ? `${s / 60} min` : `${s} s`)).join(', ') })}</p></Card>
      <Card><H>{t('dvDeliveries')}</H>
        {d.deliveries.length === 0 ? <p className="text-[13.5px] text-mute">{t('dvDeliveriesNone')}</p>
          : <Timeline label={t('dvDeliveries')} items={d.deliveries.slice(0, 30).map((x) => ({ key: String(x.id), state: x.state === 'delivered' ? 'done' as const : x.state === 'failed' ? 'failed' as const : 'current' as const,
            title: <span className="font-mono text-[13.5px]">{x.event}</span>, stateLabel: t(`dvDel_${x.state}` as Key),
            children: <><span>{when(new Date(x.createdAt), locale)} · {t('dvAttempts', { n: x.attempts })}{x.lastStatus ? ` · HTTP ${x.lastStatus}` : ''}</span>{x.lastError && <span className="block break-words">{x.lastError}</span>}
              {x.nextAttemptAt && <span className="block">{t('dvNextAttempt', { at: when(new Date(x.nextAttemptAt), locale) })}</span>}</> }))} />}</Card>
      {adding && <Sheet title={t('dvHookNew')} onClose={() => setAdding(false)} busy={busy} testid="dev-hook"
        footer={<Btn full busy={busy} disabled={!url.trim() || events.length === 0} onClick={() => void run(async () => { const r = await post(`${P}/webhooks`, { url: url.trim(), events, label: label.trim() }); setAdding(false); setSecret({ id: r.webhook.id, secret: r.secret }); })}>{t('save')}</Btn>}>
        <div className="space-y-4">
          <Field label={t('dvHookUrl')} hint={t('dvHookUrlHint')}><input className={inputCls} type="url" inputMode="url" value={url} placeholder="https://example.com/spw-hook" onChange={(e) => setUrl(e.target.value)} /></Field>
          <Field label={t('label')}><input className={inputCls} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} /></Field>
          <fieldset><legend className="mb-1 text-[13px] font-medium text-mute">{t('dvHookEvents')}</legend>
            {d.events.map((e) => <Check key={e.event} on={events.includes(e.event)} onChange={(on) => setEvents(on ? [...events, e.event] : events.filter((x) => x !== e.event))} hint={e.emitted ? undefined : t('dvEvPending')}><span className="font-mono text-[13.5px]">{e.event}</span></Check>)}</fieldset>
          {fail && <Notice tone="danger">{fail}</Notice>}
        </div></Sheet>}
      {secret && <Sheet title={t('dvHookSecretTitle')} sub={secret.id} onClose={() => setSecret(null)} dismissable={false} footer={<Btn full onClick={() => setSecret(null)}>{t('dvSecretSaved')}</Btn>}>
        <div className="space-y-3"><Notice tone="warn">{t('dvHookSecretOnce')}</Notice><p className="break-all rounded-2xl bg-elev p-3.5 font-mono text-[13px]">{secret.secret}</p><CopyBtn text={secret.secret} full /></div></Sheet>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- docs
const METHOD_TONE: Record<string, Tone> = { GET: 'info', POST: 'ok', DELETE: 'danger' };
function Operation({ op }: { op: DocOp }) {
  const t = useT();
  return (
    <Fold testid={`dev-op-${op.id}`} summary={<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><Tag tone={METHOD_TONE[op.method] ?? 'mute'}>{op.method}</Tag><span className="min-w-0 break-all font-mono text-[12.5px]">{op.path}</span>
      {!op.implemented && <Tag tone="warn" icon="clock">501</Tag>}</span>}>
      <div className="space-y-3 text-[13.5px] leading-snug">
        <p className="font-medium">{op.summary}</p>
        {op.description && <p className="text-mute">{op.description}</p>}
        <div className="flex flex-wrap gap-1.5"><Tag tone="info" icon="key">{t('dvOpScope')} : {op.scope}</Tag>
          <Tag tone={op.implemented ? 'ok' : 'warn'} icon={op.implemented ? 'check' : 'clock'}>{t(op.implemented ? 'dvOpImplemented' : 'dvOpNotWired')}</Tag>
          {op.idempotent && <Tag tone="mute">Idempotency-Key</Tag>}{op.needsMandate && <Tag tone="warn" icon="lock">{t('dvOpMandate')}</Tag>}</div>
        {op.params.length > 0 && <div><p className="t-eyebrow mb-1">{t('dvParams')}</p>
          <dl>{op.params.map((p) => <Fact key={`${p.in}:${p.name}`} k={<span className="font-mono text-[12.5px]">{p.name}<span className="text-mute"> · {p.in}{p.required ? ` · ${t('dvRequired')}` : ''}</span></span>}>
            <span className="font-mono text-[12.5px]">{p.type}</span>{p.description && <span className="block text-xs text-mute">{p.description}</span>}</Fact>)}</dl></div>}
        {op.body && <div><p className="t-eyebrow mb-1">{t('dvBody')}</p><Code label={t('dvBody')}>{op.body}</Code></div>}
        <div><p className="t-eyebrow mb-1">{t('dvResponses')}</p>
          <dl>{op.responses.map((r) => <Fact key={r.code} k={<span className="font-mono">{r.code}</span>}>{r.description}</Fact>)}</dl></div>
      </div>
    </Fold>
  );
}
function Docs() {
  const t = useT();
  const q = useQuery({ queryKey: ['dev', 'openapi'], queryFn: () => get<Record<string, unknown>>('/trading/openapi.json'), staleTime: 300_000 });
  const tags = useMemo(() => docTags(docOps(q.data)), [q.data]);
  const examples = useMemo(() => codeExamples(location.origin), []);
  const [lang, setLang] = useState<'curl' | 'python' | 'typescript'>('python');
  const info = q.data?.info as { title?: string; version?: string } | undefined;
  return (
    <div className="space-y-4">
      <Card className="space-y-3"><H>{t('dvAuthTitle')}</H>
        <p className="text-[14px] leading-snug">{t('dvAuthHow')}</p>
        <Code label={t('dvAuthTitle')}>{'Authorization: Bearer spw_live_<key id>_<secret>'}</Code>
        <p className="text-xs leading-snug text-mute">{t('dvCustodyNote')}</p></Card>
      <Card><H>{t('dvExamples')}</H>
        <Seg label={t('dvExamples')} value={lang} options={examples.map((e) => [e.id, e.title] as const)} onChange={setLang} />
        <div className="mt-3 space-y-2">{examples.filter((e) => e.id === lang).map((e) => <div key={e.id} className="space-y-2"><Code label={e.title}>{e.code}</Code><CopyBtn text={e.code} full /></div>)}</div></Card>
      <Card><H right={info?.version ? <Tag>{`v${info.version}`}</Tag> : undefined}>{t('dvReference')}</H>
        <p className="mb-3 text-[13.5px] leading-snug text-mute">{t('dvDocsLead')} <a className="font-medium text-blue underline" href="/api/v1/trading/openapi.json" target="_blank" rel="noreferrer">openapi.json</a></p>
        {q.isLoading && <SkeletonCard lines={4} className="!p-0 !shadow-none" />}
        {q.isError && <ErrorState title={t('dvDocsError')} onRetry={() => void q.refetch()} />}
        {tags.map((g) => <Section key={g.tag} title={`${g.tag} · ${g.ops.length}`} className="mb-3"><div className="divide-y divide-line">{g.ops.map((op) => <Operation key={op.id} op={op} />)}</div></Section>)}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- status
function Status() {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['dev', 'status'], queryFn: () => get<StatusAnswer>(`${P}/status`), refetchInterval: 20_000 });
  if (q.isLoading) return <SkeletonRows n={5} />;
  if (q.isError || !q.data) return <ErrorState title={t('dvLoadError')} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const svcName = (id: string) => (id.startsWith('venue:') ? t('dvSvcVenue', { name: id.slice(6) }) : t(`dvSvc_${id.replace('-', '_')}` as Key));
  return (
    <div className="space-y-4">
      <StatGrid cols={3}>
        <Stat label={t('dvOpsConnected')} value={`${d.api.implemented} / ${d.api.operations}`} sub={`v${d.api.version}`} />
        <Stat label={t('dvKeysActive')} value={d.keys ? `${d.keys.active} / ${d.keys.total}` : '—'} />
        <Stat label={t('dvRateDefault')} value={t('dvRate', { n: d.rateLimits.defaultPerMin })} sub={t('dvRateMax', { n: d.rateLimits.maxPerMin })} />
      </StatGrid>
      <Card><H>{t('dvServices')}</H>
        <ul className="divide-y divide-line">{d.services.map((s) => <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5" data-testid={`dev-svc-${s.id}`}>
          <span className="min-w-0"><span className="block text-[14.5px] font-medium">{svcName(s.id)}</span><span className="block break-words text-xs text-mute">{/* v11 interface (audit B3): the server's own sentence — translated when known, a marked English quotation otherwise */ srvText(t, locale, s.detail)}</span></span>
          <Tag tone={s.ok ? 'ok' : s.id === 'execution' ? 'warn' : 'danger'} icon={s.ok ? 'check' : 'warn'}>{t(s.ok ? 'dvSvcOk' : s.id === 'execution' ? 'dvOpNotWired' : 'dvSvcKo')}</Tag></li>)}</ul>
        <p className="mt-2 text-xs text-mute">{when(new Date(d.ts), locale)}</p></Card>
      <Card><H>{t('dvRateLimits')}</H>
        <dl><Fact k={t('dvRateDefault')}>{t('dvRate', { n: d.rateLimits.defaultPerMin })}</Fact><Fact k={t('dvRateMaxK')}>{t('dvRate', { n: d.rateLimits.maxPerMin })}</Fact>
          <Fact k={t('dvAuthThrottle')}>{t('dvAuthThrottleV', { n: d.rateLimits.failedAuthPerMinPerAddress })}</Fact><Fact k={t('dvRateHeaders')} mono>{d.rateLimits.headers.join(', ')}</Fact></dl></Card>
      <Card><H>{t('dvNotWiredList')}</H>
        <p className="mb-2 text-[13.5px] leading-snug text-mute">{t('dvNotWiredBody')}</p>
        <ul className="space-y-1 font-mono text-[12.5px]">{d.api.notImplemented.map((o) => <li key={o} className="break-all">{o}</li>)}</ul></Card>
    </div>
  );
}
