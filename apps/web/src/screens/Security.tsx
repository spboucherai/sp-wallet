// NEXT — Security Center (design system §5): signer and halt state · passkeys FROM THE SIGNER (the source of truth for who can
// approve), add and revoke · sessions (the current one marked, revoke one, revoke all) · last sign-ins (a new device flagged)
// · security alerts · limits (read-only) · recovery status · the audit journal.
// Adding and revoking a passkey are approvals: their outcome is what the SERVER says (approval.ts / approvalUi.tsx), exactly
// as for a transfer — a lost answer is read back from the server, never guessed.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { alertPath, renderAlert } from '../../../../packages/core/src/alert-catalog';
import type { AlertItem } from '../alerts';
import { ApiError, APPROVE_TIMEOUT_MS, get, post, routeMissing } from '../api';
import { ApprovalOutcomePanel, inDoubt, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says
import { useNetworks } from '../hooks';
import { errText, I18n, useT, type Key } from '../i18n';
import { IN_APP } from '../nav';
import { Btn, Card, Coin, ErrorState, Fact, H, Icon, inputCls, Notice, PageTitle, Sheet, Skeleton, SkeletonRows, Tag, when } from '../ui';
import { mismatchIds, useLogins, useSecurity, type SecDevice, type SecSession, type SecurityOverview } from '../wallet-more';
import { useFallbackInterval } from '../wallet-ui';

const fmt = (v: string, d: number) => { const s = v.padStart(d + 1, '0'); const i = s.slice(0, s.length - d), f = s.slice(s.length - d).replace(/0+$/, ''); return f ? `${i}.${f}` : i; };
/** one passkey as the screen lists it: the signer's row when it has one (it can approve), joined with what the application knows of it */
export interface PasskeyRow { id: string; label: string | null; onSigner: boolean; known: boolean; createdAt: string | null; lastUsedAt: string | null; inCooldown: boolean; cooldownUntil: string | null; backedUp: boolean | null; revocable: boolean }
/**
 * The passkeys to show (pure: tested). The SIGNER's list comes first and decides who can approve; a passkey the application
 * knows but the signer does not list approves nothing and is shown as such. `signerCredentials` null or absent (signer
 * unreachable, older server): the application's list alone, and the screen says the signer's could not be read.
 */
export function passkeyRows(o: Pick<SecurityOverview, 'devices' | 'signerCredentials'>): { rows: PasskeyRow[]; fromSigner: boolean } {
  const dev = (id: string): SecDevice | undefined => o.devices.find((d) => (d.credentialId ?? '') === id || (!d.credentialId && id.startsWith(d.id)));
  if (!Array.isArray(o.signerCredentials)) return { fromSigner: false, rows: o.devices.map((d) => ({ id: d.credentialId ?? d.id, label: d.label, onSigner: !!d.enrolledOnSigner, known: true, createdAt: d.createdAt ?? null, lastUsedAt: d.lastUsedAt ?? null, inCooldown: !!d.inCooldown, cooldownUntil: null, backedUp: d.backedUp ?? null, revocable: !!d.revocable && !!d.credentialId })) };
  const rows: PasskeyRow[] = o.signerCredentials.map((c) => { const d = dev(c.id); return { id: c.id, label: c.label ?? d?.label ?? null, onSigner: true, known: c.known, createdAt: c.createdAt ?? d?.createdAt ?? null, lastUsedAt: c.lastUsedAt ?? d?.lastUsedAt ?? null, inCooldown: c.inCooldown, cooldownUntil: c.cooldownUntil ?? null, backedUp: d?.backedUp ?? null, revocable: c.revocable }; });
  for (const d of o.devices) if (d.credentialId && !rows.some((r) => r.id === d.credentialId)) rows.push({ id: d.credentialId, label: d.label, onSigner: false, known: true, createdAt: d.createdAt ?? null, lastUsedAt: d.lastUsedAt ?? null, inCooldown: false, cooldownUntil: null, backedUp: d.backedUp ?? null, revocable: d.revocable !== false });
  return { rows, fromSigner: true };
}
/** the three refusals of a revocation that have their own explanation; anything else is the usual error text */
const revokeError = (t: ReturnType<typeof useT>, e: unknown): string => { const c = e instanceof ApiError ? e.code : ''; return c === 'last_credential' ? t('nwSecErrLast') : c === 'no_approver' ? t('nwSecErrNoApprover') : c === 'self_approval' ? t('nwSecErrSelf') : errText(t, e); };
const openPath = (path: string): void => { history.pushState(IN_APP, '', path); dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); };

export function Security() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const nets = useNetworks();
  const slow = useFallbackInterval(30_000, 180_000);
  const ov = useSecurity(slow), logins = useLogins();
  const au = useQuery({ queryKey: ['audit'], queryFn: () => get<any>('/security/audit?limit=60'), refetchInterval: slow });
  const alerts = useQuery({ queryKey: ['alerts', 'security'], staleTime: 30_000, retry: 0, queryFn: async () => { try { return (await get<{ items: AlertItem[] }>('/alerts?limit=5&group=security')).items; } catch (e) { if (routeMissing(e)) return []; throw e; } } });
  const [showAudit, setShowAudit] = useState(false), [allLimits, setAllLimits] = useState(false), [lq, setLq] = useState('');
  const [halt, setHalt] = useState(''), [haltOpen, setHaltOpen] = useState(false), [busy, setBusy] = useState(''), [err, setErr] = useState(''); const ap = useApprovalOutcome<any>();
  const [revoking, setRevoking] = useState<PasskeyRow | null>(null), [ending, setEnding] = useState<SecSession | 'all' | null>(null);
  // NEXT W3: a failed load is an error state with a retry, not a skeleton that never ends
  if (!ov.data && ov.isError) return <div className="space-y-4" data-testid="security-error"><PageTitle>{t('security')}</PageTitle><ErrorState title={t('nxErrLoad')} offline={(ov.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void ov.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  if (ov.isLoading || !ov.data) return <div className="space-y-4" aria-busy="true"><Skeleton h="h-11" className="!w-40 !rounded-xl" /><Skeleton h="h-44" /><SkeletonRows n={4} /></div>;
  const d = ov.data, s = d.signer;
  const act = async (name: string, fn: () => Promise<unknown>, explain: (e: unknown) => string = (e) => errText(t, e)) => { setBusy(name); setErr(''); try { await fn(); await qc.invalidateQueries(); } catch (e) { if (!inDoubt(e)) setErr(explain(e)); } finally { setBusy(''); } };
  const { rows: keys, fromSigner } = passkeyRows(d), mm = mismatchIds(d.mismatch), signerCount = keys.filter((k) => k.onSigner).length;
  const addDevice = () => act('device', async () => {
    const o = await post('/security/devices/options');
    const response = await startRegistration({ optionsJSON: o.options });
    const v = await post('/security/devices/verify', { challengeId: o.challengeId, response, label: `Passkey ${d.devices.length + 1}` });
    const assertion = await startAuthentication({ optionsJSON: v.options }); // an existing passkey authorizes the new one
    // NEXT W1: a lost answer is settled by the device list read from the server (is there one more passkey?)
    const had = d.devices.length;
    await ap.send<unknown>({ submit: () => post('/security/devices/confirm', { pendingId: v.pendingId, assertion }, undefined, { interaction: true }), read: () => get<any>('/security/overview'), applied: (o) => o.devices.length > had, late: () => void qc.invalidateQueries() });
  });
  // NEXT: revoke ONE passkey — ANOTHER enrolled passkey approves, the signer verifies. A lost answer is settled by the list read from the server.
  const revoke = (k: PasskeyRow) => act(`revoke:${k.id}`, async () => {
    const o = await post<{ challengeId: string; options: any }>('/security/devices/revoke/options', { credentialId: k.id });
    setRevoking(null);
    const assertion = await startAuthentication({ optionsJSON: o.options });
    const gone = (x: SecurityOverview) => !passkeyRows(x).rows.some((r) => r.id === k.id);
    await ap.send<unknown>({ submit: () => post('/security/devices/revoke/confirm', { challengeId: o.challengeId, assertion }, undefined, { interaction: true, timeoutMs: APPROVE_TIMEOUT_MS }), read: () => get<SecurityOverview>('/security/overview'), applied: gone, late: () => void qc.invalidateQueries() });
  }, (e) => revokeError(t, e));
  const endSession = (x: SecSession | 'all') => act('session', async () => { await post(x === 'all' ? '/security/sessions/revoke-all' : `/security/sessions/${encodeURIComponent(x.id!)}/revoke`); setEnding(null); });
  const limitKeys: string[] = s.reachable && s.policy ? Object.keys(s.policy.perTx).sort() : [];
  const nameOf = (net: string) => nets.data?.find((x) => x.id === net)?.name ?? net;
  const lf = lq.trim().toLowerCase(), shown = !allLimits || !lf ? [...limitKeys] : limitKeys.filter((k) => { const [net, sym] = k.split(':') as [string, string]; return sym.toLowerCase().includes(lf) || nameOf(net).toLowerCase().includes(lf) || net.includes(lf); });
  const decOf = (net: string, sym: string) => { const n = nets.data?.find((x) => x.id === net); return (n?.native.symbol === sym ? n.native : n?.tokens.find((x) => x.symbol === sym))?.decimals ?? 0; };
  const date = (v: string | null | undefined) => (v ? when(v, locale) : t('never'));
  const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium' }) : '—');
  const cooldownH = s.credentialCooldownSec ? Math.round(s.credentialCooldownSec / 3600) : 0;
  return (
    <div className="space-y-4" data-testid="security">
      <PageTitle>{t('security')}</PageTitle>
      {err && <Notice tone="danger" testid="security-err">{err}</Notice>}
      <ApprovalOutcomePanel ap={ap} />
      {mm.any && <Notice tone="danger" testid="cred-mismatch"><b className="block font-semibold">{t('nwSecMismatchTitle')}</b>
        {mm.signerOnly.length > 0 && <span className="block">{t('nwSecMismatchSigner', { n: mm.signerOnly.length })}</span>}{mm.apiOnly.length > 0 && <span className="block">{t('nwSecMismatchApi', { n: mm.apiOnly.length })}</span>}</Notice>}
      <div className="panes space-y-4 lg:space-y-0"><div className="min-w-0 space-y-4">
        <Card>
          <H>{t('signer')}</H>
          {!s.reachable ? <Notice tone="danger" testid="signer-unreachable">{t('signer')} : {t('unreachable')}</Notice> : <>
            <div className={`t-body-strong flex items-center gap-3 rounded-[var(--radius-md)] p-3 ${s.halted ? 'bg-negative/[0.09] text-negative' : 'bg-positive/[0.08] text-positive'}`} data-testid="signer-state" data-halted={!!s.halted}><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${s.halted ? 'bg-negative/15' : 'bg-positive/15'}`}><Icon n={s.halted ? 'stop' : 'check'} /></span>{s.halted ? t('signingOff') : t('signingOn')}</div>
            <dl className="mt-2"><Fact k={t('keyId')} mono>{s.keyId}</Fact>
              <Fact k={t('signerJournal')}>{s.journalLength} {s.journalLength === 1 ? t('qaEntries1') : t('entries')}</Fact></dl>
            {s.halted && <p className="t-footnote reading mt-2 text-mute">{t('nwSecHaltedBody')}</p>}
            {!s.halted && (haltOpen ? <div className="mt-4 space-y-3"><Notice tone="danger">{t('haltConfirm')}</Notice>
              <input className={inputCls} value={halt} onChange={(e) => setHalt(e.target.value)} placeholder="STOP" autoCapitalize="characters" aria-label="STOP" />
              <div className="grid grid-cols-2 gap-3"><Btn kind="ghost" onClick={() => { setHaltOpen(false); setHalt(''); }}>{t('cancel')}</Btn>
                <Btn kind="danger" busy={busy === 'halt'} disabled={halt.trim().toUpperCase() !== 'STOP'} onClick={() => act('halt', () => post('/security/emergency-halt'))}>{t('halt')}</Btn></div></div>
              : <Btn kind="danger" full className="mt-4" onClick={() => setHaltOpen(true)}><Icon n="stop" />{t('halt')}</Btn>)}
          </>}
        </Card>

        <Card className="!px-0 !pb-0"><div className="px-[var(--card-padding)]"><H right={<span className="t-footnote text-mute">{fromSigner ? t('nwSecKeysSigner', { n: signerCount }) : ''}</span>}>{t('devices')}</H>
          {!fromSigner && <div className="mb-3"><Notice tone="warn" testid="keys-not-from-signer">{t('nwSecKeysApiOnly')}</Notice></div>}</div>
          <ul data-testid="passkeys">{keys.map((k) => <li key={k.id} className="row flex-wrap sm:flex-nowrap" data-testid="passkey" data-id={k.id} data-on-signer={k.onSigner}>
            <span className="disc" data-tone={k.onSigner && k.known ? undefined : 'caution'} aria-hidden="true"><Icon n="key" className="h-[1.125rem] w-[1.125rem]" /></span>
            <div className="min-w-[min(13rem,100%)] flex-1"><div className="t-body-strong flex flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate">{k.label ?? t('nwSecKeyUnnamed')}</span>
                {!k.known && <Tag tone="danger" icon="warn" testid="key-unknown">{t('nwSecKeyUnknown')}</Tag>}{!k.onSigner && <Tag tone="warn" icon="warn" testid="key-not-on-signer">{t('nwSecKeyNotOnSigner')}</Tag>}
                {k.inCooldown && <Tag tone="info" icon="clock" testid="key-cooldown">{t('nwSecKeyCooldown')}</Tag>}</div>
              <div className="t-footnote text-mute"><span className="font-mono">{k.id.slice(0, 12)}…</span>{k.backedUp !== null && <> · {k.backedUp ? t('synced') : t('deviceBound')}</>}</div>
              <div className="t-footnote text-mute">{t('nwSecKeyAdded', { date: day(k.createdAt) })} · {t('lastUsed')} {date(k.lastUsedAt)}</div>
              {k.inCooldown && k.cooldownUntil && <div className="t-footnote text-mute">{t('nwSecKeyCooldownUntil', { date: when(k.cooldownUntil, locale) })}</div>}</div>
            {k.revocable ? <Btn kind="ghost" className="!min-h-11 shrink-0 !px-4 !text-[0.84375rem] max-sm:ml-[3.25rem]" disabled={ap.locked || !!busy} busy={busy === `revoke:${k.id}`} onClick={() => { setErr(''); setRevoking(k); }} data-testid="passkey-revoke">{t('nwSecRevoke')}</Btn>
              : <span className="t-footnote shrink-0 text-mute max-sm:ml-[3.25rem] sm:max-w-[9rem] sm:text-right" data-testid="passkey-last">{t('nwSecKeyLast')}</span>}</li>)}</ul>
          <div className="border-t border-line p-[var(--card-padding)]"><Btn kind="soft" full busy={busy === 'device'} disabled={ap.locked || !!busy} onClick={addDevice} data-testid="passkey-add"><Icon n="key" />{t('addDevice')}</Btn>
            <p className="t-footnote mt-2 text-mute">{t('addDeviceNote')}{cooldownH > 0 ? ` ${t('nwSecCooldownNote', { h: cooldownH })}` : ''}</p></div></Card>

        <Card><H>{t('recovery')}</H>
          <dl data-testid="recovery-status">
            <Fact k={t('nwSecRecoveryNoted')} testid="recovery-exported">{!s.reachable ? '—' : s.recoveryExportedAt ? <Tag tone="ok" icon="check">{t('nwSecOn', { date: when(s.recoveryExportedAt, locale) })}</Tag> : <Tag tone="warn" icon="warn">{t('never')}</Tag>}</Fact>
            <Fact k={t('nwSecRecoveryVerified')} testid="recovery-verified">{!s.reachable ? '—' : s.recoveryVerifiedAt ? <Tag tone="ok" icon="check">{t('nwSecOn', { date: when(s.recoveryVerifiedAt, locale) })}</Tag> : <Tag tone="mute" icon="clock">{t('never')}</Tag>}</Fact>
            <Fact k={t('nwSecBackups')} testid="backup-state"><span className="font-normal text-mute">{t('nwSecBackupsUnknown')}</span></Fact>
          </dl>
          {s.reachable && !s.recoveryExportedAt && <div className="mt-3"><Notice tone="warn" testid="recovery-never">{t('nwSecRecoveryNever')}</Notice></div>}
          <p className="t-callout reading mt-3 text-mute">{t('recoveryBody')}</p>
          <pre className="t-mono mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-elev/70 p-3">node ~/apps/sp-wallet-signer/signer.mjs export-recovery</pre>
          <div className="mt-3"><Notice tone="warn">{t('recoveryWarn')}</Notice></div></Card>
      </div><div className="min-w-0 space-y-4">
        {(alerts.data?.length ?? 0) > 0 && <Card className="!px-0 !pb-1"><div className="px-[var(--card-padding)]"><H right={<button className="link -my-2" onClick={() => openPath('/alerts')}>{t('all')}<Icon n="chev" className="h-4 w-4" /></button>}>{t('nwSecAlerts')}</H></div>
          <ul data-testid="security-alerts">{alerts.data!.map((a) => { const x = renderAlert(a.kind, a.params as never, locale, true); return <li key={a.id}><button className="row row-press" onClick={() => openPath(alertPath(a.kind, a.subject as never))}>
            <span className="disc" data-tone={a.severity === 'critical' ? 'negative' : a.severity === 'warning' ? 'caution' : 'accent'} aria-hidden="true"><Icon n={a.severity === 'info' ? 'info' : 'warn'} className="h-[1.125rem] w-[1.125rem]" /></span>
            <span className="min-w-0 flex-1"><span className="t-body-strong block">{x.title}</span>{x.body && <span className="t-footnote block text-mute">{x.body}</span>}<span className="t-footnote block text-mute">{when(new Date(a.ts), locale)}</span></span></button></li>; })}</ul></Card>}

        <Card className="!px-0 !pb-0"><div className="px-[var(--card-padding)]"><H>{t('sessions')}</H></div>
          <ul data-testid="sessions">{d.sessions.map((x, k) => <li key={x.id ?? k} className="row flex-wrap sm:flex-nowrap" data-testid="session" data-current={!!x.current}>
            <span className="disc" data-tone={x.current ? 'positive' : undefined} aria-hidden="true"><Icon n="device" className="h-[1.125rem] w-[1.125rem]" /></span>
            <div className="min-w-[min(13rem,100%)] flex-1"><div className="t-body-strong flex flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate">{x.device || x.ua.replace(/Mozilla\/5.0 \(([^)]+)\).*/, '$1').slice(0, 40)}</span>{x.current && <Tag tone="ok" icon="check" testid="session-current">{t('nwSecThisSession')}</Tag>}</div>
              <div className="t-footnote text-mute">{t('nwSecLastSeen', { date: when(x.last_seen, locale) })}{x.ip ? ` · ${x.ip}` : ''}</div></div>
            {x.id && <Btn kind="ghost" className="!min-h-11 shrink-0 !px-4 !text-[0.84375rem] max-sm:ml-[3.25rem]" disabled={!!busy} onClick={() => { setErr(''); setEnding(x); }} data-testid="session-revoke">{t(x.current ? 'logout' : 'nwSecEnd')}</Btn>}</li>)}</ul>
          <div className="border-t border-line p-[var(--card-padding)]"><Btn kind="ghost" full disabled={!!busy} onClick={() => { setErr(''); setEnding('all'); }} data-testid="sessions-revoke-all">{t('revokeAll')}</Btn></div></Card>

        {logins.data && logins.data.length > 0 && <Card className="!px-0 !pb-1"><div className="px-[var(--card-padding)]"><H>{t('nwSecLogins')}</H></div>
          <ul data-testid="logins">{logins.data.map((l) => <li key={l.seq} className="row" data-new-device={l.newDevice === true}>
            <span className="disc" data-tone={l.newDevice ? 'caution' : undefined} aria-hidden="true"><Icon n={l.newDevice ? 'warn' : 'lock'} className="h-[1.125rem] w-[1.125rem]" /></span>
            <div className="min-w-[min(13rem,100%)] flex-1"><div className="t-body-strong flex flex-wrap items-center gap-x-2 gap-y-1"><span>{when(l.at, locale)}</span>{l.newDevice && <Tag tone="warn" icon="warn" testid="login-new-device">{t('nwSecNewDevice')}</Tag>}</div>
              <div className="t-footnote text-mute">{[l.device, l.label, l.ip].filter(Boolean).join(' · ') || '—'}</div></div></li>)}</ul></Card>}

        {s.reachable && s.policy && <Card><H right={<span className="t-footnote text-mute">{allLimits ? t('qaLimitsShown', { n: shown.length, total: limitKeys.length }) : t('nwSecReadOnly')}</span>}>{t('limits')}</H>
          {allLimits && <input className={`${inputCls} mb-4`} type="search" placeholder={t('qaLimitsSearch')} aria-label={t('qaLimitsSearch')} value={lq} onChange={(e) => setLq(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
          {allLimits && shown.length === 0 && <p className="t-callout py-4 text-center text-mute">{t('qaLimitsNone')}</p>}
          <ul className={`space-y-4 ${allLimits ? 'max-h-[60vh] overflow-y-auto pr-1' : ''}`}>{shown.sort((x, y) => Number(BigInt(s.spentToday?.[y] ?? '0') > 0n) - Number(BigInt(s.spentToday?.[x] ?? '0') > 0n) || Number(y.endsWith(':USDC')) - Number(x.endsWith(':USDC')) || x.localeCompare(y)).slice(0, allLimits ? 999 : 5).map((k) => { const [net, sym] = k.split(':') as [string, string];
            const dec = decOf(net, sym);
            const day = BigInt(s.policy!.daily[k] ?? '0'), used = BigInt(s.spentToday?.[k] ?? '0'), pct = day > 0n ? Number((used * 100n) / day) : 0;
            return <li key={k}>
              <div className="flex items-center gap-3"><Coin sym={sym} net={net} size={36} />
                <div className="min-w-0 flex-1"><div className="t-body-strong leading-tight">{sym} <span className="font-normal text-mute">· {nameOf(net)}</span></div>
                  <div className="t-footnote text-mute">{fmt(s.policy!.perTx[k]!, dec)} {t('perTxShort')}</div></div>
                <div className="text-right"><div className="t-body-strong amt leading-tight">{fmt((day - used > 0n ? day - used : 0n).toString(), dec)}</div><div className="t-footnote text-mute">{t('remaining')}</div></div></div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-elev" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${sym} ${nameOf(net)}`}><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} /></div>
            </li>; })}</ul>
          {limitKeys.length > 5 && <button className="link mt-2" aria-expanded={allLimits} onClick={() => { setAllLimits(!allLimits); setLq(''); }}>{allLimits ? t('showLess') : `${t('showAll')} (${limitKeys.length})`}</button>}
          <p className="t-footnote reading mt-3 text-mute">{t('limitsNote')}</p></Card>}

        <Card><H right={au.data && <span className={`t-footnote inline-flex items-center gap-1 ${au.data.intact ? 'text-positive' : 'text-negative'}`}><Icon n={au.data.intact ? 'check' : 'warn'} className="h-3.5 w-3.5" />{au.data.intact ? t('auditIntact') : `${t('auditBroken')} ${au.data.brokenAt}`}</span>}>{t('audit')}</H>
          <button className="link" aria-expanded={showAudit} onClick={() => setShowAudit(!showAudit)}>{showAudit ? t('hideAudit') : `${t('seeAudit')} (${au.data?.total ?? 0})`}</button>
          {showAudit && <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto">{(au.data?.events ?? []).map((e: any) => <li key={e.seq} className="rounded-[var(--radius-sm)] bg-elev/70 px-3 py-2">
            <div className="t-footnote flex justify-between gap-2"><span className="font-mono font-medium">{e.type}</span><span className="shrink-0 text-mute">#{e.seq} · {when(e.ts, locale)}</span></div>
            <div className="t-micro truncate font-mono text-mute">{Object.entries(e.data).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(' ')}</div></li>)}</ul>}</Card>
      </div></div>

      {revoking && <Sheet title={t('nwSecRevokeTitle')} sub={revoking.label ?? t('nwSecKeyUnnamed')} onClose={() => setRevoking(null)} busy={busy.startsWith('revoke:')} testid="revoke-sheet"
        footer={<div className="grid grid-cols-2 gap-3"><Btn kind="ghost" disabled={!!busy} onClick={() => setRevoking(null)}>{t('cancel')}</Btn><Btn kind="danger" busy={busy === `revoke:${revoking.id}`} onClick={() => void revoke(revoking)} data-testid="revoke-confirm"><Icon n="key" />{t('nwSecRevokeGo')}</Btn></div>}>
        <div className="space-y-3">
          <dl><Fact stack k={t('nwSecKeyId')}><span className="t-mono break-all">{revoking.id}</span></Fact></dl>
          <Notice tone="warn">{t(revoking.onSigner ? 'nwSecRevokeBody' : 'nwSecRevokeBodyApi')}</Notice>
          <p className="t-callout text-mute">{t('nwSecRevokeOther')}</p>
          {err && <Notice tone="danger" testid="revoke-err">{err}</Notice>}
        </div></Sheet>}
      {ending && <Sheet title={t(ending === 'all' ? 'revokeAll' : ending.current ? 'nwSecEndThisTitle' : 'nwSecEndTitle')} sub={ending === 'all' ? undefined : ending.device ?? undefined} onClose={() => setEnding(null)} busy={busy === 'session'} testid="session-sheet"
        footer={<div className="grid grid-cols-2 gap-3"><Btn kind="ghost" disabled={!!busy} onClick={() => setEnding(null)}>{t('cancel')}</Btn><Btn kind="danger" busy={busy === 'session'} onClick={() => void endSession(ending)} data-testid="session-confirm">{t(ending === 'all' ? 'nwSecEndAllGo' : 'nwSecEndGo')}</Btn></div>}>
        <div className="space-y-3"><p className="t-callout">{t((ending === 'all' ? 'nwSecEndAllBody' : ending.current ? 'nwSecEndThisBody' : 'nwSecEndBody') as Key)}</p>{err && <Notice tone="danger">{err}</Notice>}</div></Sheet>}
    </div>
  );
}
