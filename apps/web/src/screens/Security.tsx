import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApprovalOutcomePanel, inDoubt, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get, post } from '../api';
import { useNetworks } from '../hooks';
import { errText, I18n, useT } from '../i18n';
import { Btn, Card, Coin, ErrorState, H, Icon, inputCls, Notice, PageTitle, Skeleton, SkeletonRows, when } from '../ui';

const fmt = (v: string, d: number) => { const s = v.padStart(d + 1, '0'); const i = s.slice(0, s.length - d), f = s.slice(s.length - d).replace(/0+$/, ''); return f ? `${i}.${f}` : i; };

export function Security() {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const nets = useNetworks();
  const ov = useQuery({ queryKey: ['security'], queryFn: () => get<any>('/security/overview'), refetchInterval: 30_000 });
  const au = useQuery({ queryKey: ['audit'], queryFn: () => get<any>('/security/audit?limit=60'), refetchInterval: 30_000 });
  const [showAudit, setShowAudit] = useState(false), [allLimits, setAllLimits] = useState(false), [lq, setLq] = useState('');
  const [halt, setHalt] = useState(''), [haltOpen, setHaltOpen] = useState(false), [busy, setBusy] = useState(''), [err, setErr] = useState(''); const ap = useApprovalOutcome<any>();
  // NEXT W3: a failed load is an error state with a retry, not a skeleton that never ends
  if (!ov.data && ov.isError) return <div className="space-y-4" data-testid="security-error"><PageTitle>{t('security')}</PageTitle><ErrorState title={t('nxErrLoad')} offline={(ov.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void ov.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  if (ov.isLoading || !ov.data) return <div className="space-y-4" aria-busy="true"><Skeleton h="h-11" className="!w-40 !rounded-xl" /><Skeleton h="h-44" /><SkeletonRows n={4} /></div>;
  const s = ov.data.signer;
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); try { await fn(); await qc.invalidateQueries(); } catch (e) { if (!inDoubt(e)) setErr(errText(t, e)); } finally { setBusy(''); } };
  const addDevice = () => act('device', async () => {
    const o = await post('/security/devices/options');
    const response = await startRegistration({ optionsJSON: o.options });
    const v = await post('/security/devices/verify', { challengeId: o.challengeId, response, label: `Passkey ${ov.data.devices.length + 1}` });
    const assertion = await startAuthentication({ optionsJSON: v.options }); // an existing passkey authorizes the new one
    // NEXT W1: a lost answer is settled by the device list read from the server (is there one more passkey?)
    const had = ov.data.devices.length;
    await ap.send<unknown>({ submit: () => post('/security/devices/confirm', { pendingId: v.pendingId, assertion }), read: () => get<any>('/security/overview'), applied: (o) => o.devices.length > had, late: () => void qc.invalidateQueries() });
  });
  const keys: string[] = s.reachable ? Object.keys(s.policy.perTx).sort() : [];
  const nameOf = (net: string) => nets.data?.find((x) => x.id === net)?.name ?? net;
  const lf = lq.trim().toLowerCase(), shown = !allLimits || !lf ? [...keys] : keys.filter((k) => { const [net, sym] = k.split(':') as [string, string]; return sym.toLowerCase().includes(lf) || nameOf(net).toLowerCase().includes(lf) || net.includes(lf); });
  const decOf = (net: string, sym: string) => { const n = nets.data?.find((x) => x.id === net); return (n?.native.symbol === sym ? n.native : n?.tokens.find((x) => x.symbol === sym))?.decimals ?? 0; };
  return (
    <div className="space-y-4">
      <PageTitle>{t('security')}</PageTitle>
      {err && <Notice tone="danger">{err}</Notice>}
      <ApprovalOutcomePanel ap={ap} />
      <Card>
        <H>{t('signer')}</H>
        {!s.reachable ? <Notice tone="danger">{t('signer')} : {t('unreachable')}</Notice> : <>
          <div className={`flex items-center gap-3 rounded-2xl p-3 text-[15.5px] font-semibold ${s.halted ? 'bg-danger/[0.09] text-danger' : 'bg-emerald/[0.08] text-emerald'}`}><span className={`grid h-9 w-9 place-items-center rounded-full ${s.halted ? 'bg-danger/15' : 'bg-emerald/15'}`}><Icon n={s.halted ? 'stop' : 'check'} /></span>{s.halted ? t('signingOff') : t('signingOn')}</div>
          <dl className="mt-3 space-y-1.5 text-[13px] text-mute"><div className="flex justify-between gap-3"><dt>{t('keyId')}</dt><dd className="font-mono text-ink">{s.keyId}</dd></div>
            <div className="flex justify-between gap-3"><dt>{t('signerJournal')}</dt><dd className="text-ink">{s.journalLength} {s.journalLength === 1 ? t('qaEntries1') : t('entries')}</dd></div></dl>
          {!s.halted && (haltOpen ? <div className="mt-4 space-y-3"><Notice tone="danger">{t('haltConfirm')}</Notice>
            <input className={inputCls} value={halt} onChange={(e) => setHalt(e.target.value)} placeholder="STOP" autoCapitalize="characters" aria-label="STOP" />
            <div className="grid grid-cols-2 gap-3"><Btn kind="ghost" onClick={() => { setHaltOpen(false); setHalt(''); }}>{t('cancel')}</Btn>
              <Btn kind="danger" busy={busy === 'halt'} disabled={halt.trim().toUpperCase() !== 'STOP'} onClick={() => act('halt', () => post('/security/emergency-halt'))}>{t('halt')}</Btn></div></div>
            : <Btn kind="danger" full className="mt-4" onClick={() => setHaltOpen(true)}><Icon n="stop" />{t('halt')}</Btn>)}
        </>}
      </Card>

      {s.reachable && <Card><H right={allLimits ? <span className="text-[12.5px] text-mute">{t('qaLimitsShown', { n: shown.length, total: keys.length })}</span> : undefined}>{t('limits')}</H>
        {allLimits && <input className={`${inputCls} mb-4`} type="search" placeholder={t('qaLimitsSearch')} aria-label={t('qaLimitsSearch')} value={lq} onChange={(e) => setLq(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
        {allLimits && shown.length === 0 && <p className="py-4 text-center text-[14px] text-mute">{t('qaLimitsNone')}</p>}
        <ul className={`space-y-4 ${allLimits ? 'max-h-[60vh] overflow-y-auto pr-1' : ''}`}>{shown.sort((x, y) => Number(BigInt(s.spentToday[y] ?? '0') > 0n) - Number(BigInt(s.spentToday[x] ?? '0') > 0n) || Number(y.endsWith(':USDC')) - Number(x.endsWith(':USDC')) || x.localeCompare(y)).slice(0, allLimits ? 999 : 6).map((k) => { const [net, sym] = k.split(':') as [string, string];
          const dec = decOf(net, sym);
          const day = BigInt(s.policy.daily[k] ?? '0'), used = BigInt(s.spentToday[k] ?? '0'), pct = day > 0n ? Number((used * 100n) / day) : 0;
          return <li key={k}>
            <div className="flex items-center gap-3"><Coin sym={sym} net={net} size={36} />
              <div className="min-w-0 flex-1"><div className="text-[14.5px] font-semibold leading-tight">{sym} <span className="font-normal text-mute">· {nameOf(net)}</span></div>
                <div className="text-[12.5px] text-mute">{fmt(s.policy.perTx[k], dec)} {t('perTxShort')}</div></div>
              <div className="text-right"><div className="text-[14.5px] font-semibold leading-tight">{fmt((day - used > 0n ? day - used : 0n).toString(), dec)}</div><div className="text-[12.5px] text-mute">{t('remaining')}</div></div></div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-elev" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${sym} ${nameOf(net)}`}><div className="h-full rounded-full bg-blue" style={{ width: `${Math.min(100, pct)}%` }} /></div>
          </li>; })}</ul>
        {keys.length > 6 && <button className="mt-2 min-h-11 text-[14px] font-medium text-blue" aria-expanded={allLimits} onClick={() => { setAllLimits(!allLimits); setLq(''); }}>{allLimits ? t('showLess') : `${t('showAll')} (${keys.length})`}</button>}
        <p className="mt-4 text-[12.5px] text-mute">{t('limitsNote')}</p></Card>}

      <Card><H>{t('devices')}</H>
        <ul className="space-y-3">{ov.data.devices.map((d: any) => <li key={d.id} className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-elev"><Icon n="key" /></span>
          <div className="min-w-0 flex-1"><div className="font-medium">{d.label} <span className="font-mono text-xs text-mute">{d.id}…</span></div>
            <div className="text-xs text-mute">{d.backedUp ? t('synced') : t('deviceBound')} · {t('lastUsed')} {d.lastUsedAt ? when(d.lastUsedAt, locale) : t('never')}</div></div>
          <span className={`text-xs ${d.enrolledOnSigner ? 'text-emerald' : 'text-warn'}`}><Icon n={d.enrolledOnSigner ? 'check' : 'warn'} className="inline h-4 w-4" /></span></li>)}</ul>
        <Btn kind="soft" full className="mt-4" busy={busy === 'device'} disabled={ap.locked} onClick={addDevice}><Icon n="key" />{t('addDevice')}</Btn>
        <p className="mt-2 text-xs text-mute">{t('addDeviceNote')}</p></Card>

      <Card><H>{t('recovery')}</H><p className="text-[13.5px] text-mute">{t('recoveryBody')}</p>
        <pre className="mt-2 overflow-x-auto rounded-2xl bg-elev/70 p-3 font-mono text-[12px]">node ~/apps/sp-wallet-signer/signer.mjs export-recovery</pre>
        <div className="mt-3"><Notice tone="warn">{t('recoveryWarn')}</Notice></div></Card>

      <Card><H>{t('sessions')}</H>
        <ul className="space-y-2 text-[13px]">{ov.data.sessions.map((x: any, k: number) => <li key={k} className="flex justify-between gap-3"><span className="truncate text-mute">{x.ua.replace(/Mozilla\/5.0 \(([^)]+)\).*/, '$1').slice(0, 40)}</span><span className="shrink-0">{when(x.last_seen, locale)}</span></li>)}</ul>
        <Btn kind="ghost" full className="mt-4" busy={busy === 'revoke'} onClick={() => act('revoke', () => post('/security/sessions/revoke-all'))}>{t('revokeAll')}</Btn></Card>

      <Card><H right={au.data && <span className={`inline-flex items-center gap-1 text-xs ${au.data.intact ? 'text-emerald' : 'text-danger'}`}><Icon n={au.data.intact ? 'check' : 'warn'} className="h-3.5 w-3.5" />{au.data.intact ? t('auditIntact') : `${t('auditBroken')} ${au.data.brokenAt}`}</span>}>{t('audit')}</H>
        <button className="min-h-11 text-[14px] font-medium text-blue" aria-expanded={showAudit} onClick={() => setShowAudit(!showAudit)}>{showAudit ? t('hideAudit') : `${t('seeAudit')} (${au.data?.total ?? 0})`}</button>
        {showAudit && <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto text-[12.5px]">{(au.data?.events ?? []).map((e: any) => <li key={e.seq} className="rounded-xl bg-elev/70 px-3 py-2">
          <div className="flex justify-between gap-2"><span className="font-mono font-medium">{e.type}</span><span className="shrink-0 text-mute">#{e.seq} · {when(e.ts, locale)}</span></div>
          <div className="truncate font-mono text-[11px] text-mute">{Object.entries(e.data).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(' ')}</div></li>)}</ul>}</Card>
    </div>
  );
}
