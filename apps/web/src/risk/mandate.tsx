// V11 Risk — trading mandates: the creation form (for an API key or an agent) and the approval sheet.
// The form sends exactly the body of POST /api/v1/mandates (services/api/src/mandates/service.ts MandateCreateSchema); the
// server validates, compiles a live mandate for the isolated signer and refuses what the signer cannot bound. Nothing has any
// effect before the approval. The sheet shows every field, who enforces each (signer / signer partly / API only, the server's
// own notes verbatim), the FULL mandate hash and the hash of the derivative mandate — then, for a live mandate, two passkey
// prompts: one verified by the isolated signer (the derivative mandate), one by the API (the full hash).
import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApprovalOutcomePanel, inDoubt, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says

import { amountOf, sanitizeAmountText } from '../amount';
import { AmountProblem } from '../amountUi';
import { get, post } from '../api';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Fact, Field, Icon, inputCls, Notice, Seg, Sheet, Tag, when, type Tone } from '../ui';

export interface Enforcement { field: string; enforcedBy: 'signer' | 'signer_partial' | 'api_only' | 'not_applicable'; signerField: string | null; note: string }
export interface ApprovalSheet {
  mandateId: string; mandate: Record<string, unknown>; hash: string; mode: string; enforcement: Enforcement[]; derived: { field: string; value: string; from: string }[]; passkey: boolean; note: string;
  principalDescriptor: string | null;
  signer: { hash: string; options: unknown; acknowledgement: { text: string; title?: string }; warning?: string } | null;
  binding?: { domain: string; hash: string; options: unknown; expiresAt: number; intent: { tradingMandateHash: string; signer: { mandateHash: string } } };
}
const ENF_TONE: Record<Enforcement['enforcedBy'], Tone> = { signer: 'ok', signer_partial: 'warn', api_only: 'danger', not_applicable: 'mute' };
export const EnforcementTable = ({ rows }: { rows: Enforcement[] }) => { const t = useT(); return (
  <ul className="divide-y divide-line" data-testid="rk-enforcement">{rows.map((e) => <li key={e.field} className="py-2.5" data-testid={`rk-enf-${e.field}`} data-enforced={e.enforcedBy}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[13px]">{e.field}</span><Tag tone={ENF_TONE[e.enforcedBy]}>{t(`rkEnf_${e.enforcedBy}` as Key)}</Tag></div>
    <p className="mt-1 text-[12.5px] leading-snug text-mute">{e.signerField ? `${e.signerField} — ` : ''}{e.note}</p></li>)}</ul>); };

/** one field of a mandate as a sentence a person reads (never raw JSON) */
function fieldText(k: string, v: unknown, locale: string): string {
  if (v === null || v === undefined) return '—';
  if (k === 'createdAt' || k === 'notBefore' || k === 'notAfter') return when(new Date(Number(v) * 1000), locale);
  if (k === 'principal') { const p = v as { kind: string; id: string }; return `${p.kind}:${p.id}`; }
  if (k === 'frequency') { const f = v as { perMinute: number; perHour: number; perDay: number }; return `${f.perMinute} / min · ${f.perHour} / h · ${f.perDay} / 24 h`; }
  if (k === 'accounts') return (v as Record<string, unknown>[]).map((a) => (a.kind === 'vault' ? `vault ${String(a.vaultIndex)} · ${String(a.network)} · ${String(a.address)}` : `${String(a.venue)} · ${String(a.network)} · ${String(a.account)}`)).join(' ; ');
  if (k === 'stopConditions') { const s = v as Record<string, unknown>[]; return s.length ? s.map((c) => `${String(c.kind)} ${String(c.usd ?? c.bps ?? c.count ?? c.ms)}`).join(' ; ') : '—'; }
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
export function MandateFields({ mandate, testid }: { mandate: Record<string, unknown>; testid?: string }) {
  const { locale } = useContext(I18n);
  return <dl data-testid={testid}>{Object.entries(mandate).map(([k, v]) => <Fact key={k} k={<span className="font-mono text-[12.5px]">{k}</span>}><span className="break-all" data-field={k}>{fieldText(k, v, locale)}</span></Fact>)}</dl>;
}

export function MandateApprovalSheet({ sheet, onClose, onDone, onError }: { sheet: ApprovalSheet; onClose: () => void; onDone: () => void; onError: (e: unknown) => string }) {
  const t = useT();
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false); const [fail, setFail] = useState(''); const [step, setStep] = useState(0);
  const live = sheet.passkey && !!sheet.signer; const ap = useApprovalOutcome<{ id: string; state: string }>();
  const pending = (s: string) => s === 'created' || s === 'pending_signer', readMandate = async () => { const m = (await get<{ mandates: { id: string; state: string }[] }>('/mandates')).mandates.find((x) => x.id === sheet.mandateId); if (!m) throw new Error('mandate not listed'); return m; };
  const approve = async () => {
    setBusy(true); setFail('');
    try {
      if (!live) { await post(`/mandates/${sheet.mandateId}/approve`, {}); onDone(); return; }
      setStep(1);                                                                           // 1 — the isolated signer: the derivative mandate
      const assertion = await startAuthentication({ optionsJSON: sheet.signer!.options as never });
      setStep(2);                                                                           // 2 — the API: the FULL trading mandate hash
      const bindingAssertion = sheet.binding ? await startAuthentication({ optionsJSON: sheet.binding.options as never }) : undefined;
      // NEXT W1: a lost answer is settled by the mandate read from the server (is it still awaiting its approval?)
      await ap.send<unknown>({ submit: () => post(`/mandates/${sheet.mandateId}/approve`, { assertion, ...(bindingAssertion ? { bindingAssertion } : {}), acknowledged: true }), read: readMandate, applied: (m) => !pending(m.state), late: onDone });
      onDone();
    } catch (e) { if (!inDoubt(e)) setFail(onError(e)); } finally { setBusy(false); setStep(0); }
  };
  return (
    <Sheet title={t('rkSheetTitle')} sub={String(sheet.mandate.label ?? '')} onClose={onClose} busy={busy || ap.locked} wide testid="rk-sheet"
      footer={<Btn full busy={busy} disabled={(live && !ack) || ap.locked} onClick={() => void approve()} data-testid="rk-sheet-approve">{live ? <><Icon n="key" className="h-4 w-4" />{step ? t('rkSheetStep', { n: step }) : t('rkSheetPasskey2')}</> : t('rkSheetApprove')}</Btn>}>
      <div className="space-y-3">
        <Notice tone={live ? 'warn' : 'info'}>{live ? t('rkSheetTwo') : t('rkSheetPaper')}</Notice>
        <dl>
          <Fact k={t('rkHashFull')}><span className="break-all font-mono text-[12.5px]" data-testid="rk-sheet-hash">{sheet.hash}</span></Fact>
          {sheet.signer && <Fact k={t('rkSignerHash')}><span className="break-all font-mono text-[12.5px]" data-testid="rk-sheet-signer-hash">{sheet.signer.hash}</span></Fact>}
          {sheet.principalDescriptor && <Fact k={t('rkPrincipalDesc')}><span className="break-all font-mono text-[12.5px]">{sheet.principalDescriptor}</span></Fact>}
        </dl>
        {live && <p className="text-[12.5px] leading-snug text-mute">{t('rkHashBody')}</p>}
        <h3 className="text-[14px] font-semibold">{t('rkFields')}</h3>
        <MandateFields mandate={sheet.mandate} testid="rk-sheet-fields" />
        {sheet.derived.length > 0 && <><h3 className="text-[14px] font-semibold">{t('rkDerived')}</h3>
          <dl>{sheet.derived.map((x) => <Fact key={x.field} k={<span className="font-mono text-[12.5px]">{x.field}</span>}><span className="break-all">{x.value}</span><span className="mt-0.5 block text-[12.5px] text-mute">{x.from}</span></Fact>)}</dl></>}
        <h3 className="text-[14px] font-semibold">{t('rkEnforcement')}</h3>
        <p className="text-[12.5px] leading-snug text-mute">{t('rkEnforcementBody')}</p>
        <EnforcementTable rows={sheet.enforcement} />
        {sheet.signer && <><h3 className="text-[14px] font-semibold">{sheet.signer.acknowledgement.title ?? t('rkAck')}</h3>
          <p className="whitespace-pre-wrap rounded-2xl bg-elev p-3 text-[13px] leading-relaxed">{sheet.signer.acknowledgement.text}</p>
          {sheet.signer.warning && <Notice tone="warn">{sheet.signer.warning}</Notice>}
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-[18px] w-[18px] shrink-0 accent-blue" data-testid="rk-sheet-ack" /><span className="text-[14px]">{t('rkAckCheck')}</span></label></>}
        {fail && !ap.locked && <Notice tone="danger">{fail}</Notice>}
        <ApprovalOutcomePanel ap={ap} />
      </div></Sheet>);
}

// ---------------------------------------------------------------------------------------------------------------- creation
interface KeyRow { id: string; name: string; status: string }
interface AgentRow { id: string; name: string; kind?: string; mandate?: { strategySha256?: string } | null }
interface PaperAccount { id: string; venue: string; network?: string; label?: string }
interface LiveAccount { id: string; venue: string; network: string; label?: string; account?: string; authorization: { policy: { allowedInstruments: string[]; maxLeverage: number }; active: boolean; expiresAt: number } | null }
const ORDER_TYPES = ['market', 'limit', 'stop', 'take_profit'] as const;
const STOPS = [{ kind: 'loss_gte', field: 'usd', dec: true }, { kind: 'drawdown_gte', field: 'bps', dec: false }, { kind: 'consecutive_rejects_gte', field: 'count', dec: false }, { kind: 'data_stale_gte', field: 'ms', dec: false }, { kind: 'signer_unreachable_gte', field: 'ms', dec: false }] as const;
/** a derivative mandate lasts at most 30 days at the signer; a paper mandate 90 */
export const maxDays = (mode: 'paper' | 'live'): number => (mode === 'live' ? 30 : 90);
const INT = /^\d{1,9}$/;

export function MandateForm({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: unknown) => string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const keys = useQuery({ queryKey: ['risk', 'keys'], queryFn: () => get<{ keys: KeyRow[] }>('/developer/keys') });
  const agents = useQuery({ queryKey: ['risk', 'agents'], queryFn: () => get<{ agents: AgentRow[] }>('/agents') });
  const paper = useQuery({ queryKey: ['risk', 'paper-accounts'], queryFn: () => get<{ accounts: PaperAccount[] }>('/derivatives/accounts') });
  const liveQ = useQuery({ queryKey: ['risk', 'live-accounts'], queryFn: () => get<{ accounts: LiveAccount[] }>('/derivatives/live/accounts') });
  const [kind, setKind] = useState<'api_key' | 'agent'>('api_key'); const [pid, setPid] = useState(''); const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [account, setAccount] = useState(''); const [inst, setInst] = useState<string[]>([]); const [instText, setInstText] = useState('');
  const [types, setTypes] = useState<string[]>(['market', 'limit']);
  const [n, setN] = useState({ maxCapitalUsd: '', maxOrderNotionalUsd: '', maxPositionNotionalUsd: '', maxLeverage: '', maxDailyLossUsd: '', floorEquityUsd: '', maxFeeUsd: '' });
  const [days, setDays] = useState('7'); const [freq, setFreq] = useState({ perMinute: '5', perHour: '20', perDay: '40' }); const [slip, setSlip] = useState('50');
  const [stops, setStops] = useState<Record<string, string>>({}); const [sha, setSha] = useState(''); const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false); const [fail, setFail] = useState('');

  const principals = kind === 'api_key' ? (keys.data?.keys ?? []).filter((k) => k.status === 'active').map((k) => ({ id: k.id, name: `${k.name} · ${k.id}` })) : (agents.data?.agents ?? []).map((a) => ({ id: a.id, name: `${a.name}${a.kind === 'perp' ? ' · perp' : ''}` }));
  const accounts = mode === 'paper' ? (paper.data?.accounts ?? []).map((a) => ({ id: a.id, venue: a.venue, name: `${a.label ?? a.venue} · ${a.venue}` }))
    : (liveQ.data?.accounts ?? []).filter((a) => a.authorization).map((a) => ({ id: a.id, venue: a.venue, name: `${a.label || a.venue} · ${a.venue} ${a.network}` }));
  const acc = accounts.find((a) => a.id === account) ?? null;
  const liveAcc = mode === 'live' ? (liveQ.data?.accounts ?? []).find((a) => a.id === account) ?? null : null;
  // the instruments a mandate may name: live = the set the venue authorization pins (what the signer accepts); paper = the venue's own list
  const venueInst = useQuery({ queryKey: ['risk', 'instruments', acc?.venue ?? ''], enabled: mode === 'paper' && !!acc, queryFn: () => get<{ instruments: { id: string }[] }>(`/derivatives/instruments?venue=${encodeURIComponent(acc!.venue)}`) });
  const pinned = useMemo(() => (mode === 'live' ? liveAcc?.authorization?.policy.allowedInstruments ?? [] : (venueInst.data?.instruments ?? []).map((i) => i.id)), [mode, liveAcc, venueInst.data]);
  useEffect(() => { setInst((cur) => cur.filter((i) => pinned.length === 0 || pinned.includes(i))); }, [pinned]);
  useEffect(() => { setAccount(''); setInst([]); }, [mode]);
  useEffect(() => { setPid(''); }, [kind]);
  useEffect(() => { if (kind === 'agent') setSha((agents.data?.agents ?? []).find((a) => a.id === pid)?.mandate?.strategySha256 ?? ''); }, [kind, pid, agents.data]);

  const dec = (s: string): string | null => amountOf(s, locale);
  const dMax = maxDays(mode);
  const problems: string[] = [];
  if (!pid) problems.push('principal'); if (!account) problems.push('account'); if (!inst.length) problems.push('instruments'); if (!types.length) problems.push('orderTypes');
  for (const [k, v] of Object.entries(n)) if (dec(v) === null) problems.push(k);
  if (!INT.test(days) || Number(days) < 1 || Number(days) > dMax) problems.push('days');
  for (const [k, v] of Object.entries(freq)) if (!INT.test(v) || Number(v) < 1) problems.push(`frequency.${k}`);
  if (!INT.test(slip) || Number(slip) < 1) problems.push('maxSlippageBps');
  if (kind === 'agent' && !/^[0-9a-f]{64}$/.test(sha)) problems.push('strategySha256');
  if (!label.trim()) problems.push('label');
  const stopList: Record<string, unknown>[] = [];
  for (const s of STOPS) { const v = (stops[s.kind] ?? '').trim(); if (!v) continue; const x = s.dec ? dec(v) : INT.test(v) && Number(v) >= 1 ? Number(v) : null; if (x === null) problems.push(`stop.${s.kind}`); else stopList.push({ kind: s.kind, [s.field]: x }); }

  const toggle = (list: string[], set: (x: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const addInst = () => { const ids = instText.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).filter((x) => pinned.length === 0 || pinned.includes(x)); if (ids.length) setInst([...new Set([...inst, ...ids])]); setInstText(''); };
  const create = async () => {
    setBusy(true); setFail('');
    try {
      const r = await post<{ mandate: { id: string } }>('/mandates', { principal: { kind, id: pid }, mode, accountIds: [account], instruments: inst, orderTypes: types,
        maxCapitalUsd: dec(n.maxCapitalUsd), maxOrderNotionalUsd: dec(n.maxOrderNotionalUsd), maxPositionNotionalUsd: dec(n.maxPositionNotionalUsd), maxLeverage: dec(n.maxLeverage), maxDailyLossUsd: dec(n.maxDailyLossUsd), floorEquityUsd: dec(n.floorEquityUsd),
        days: Number(days), frequency: { perMinute: Number(freq.perMinute), perHour: Number(freq.perHour), perDay: Number(freq.perDay) }, maxSlippageBps: Number(slip), maxFeeUsd: dec(n.maxFeeUsd), stopConditions: stopList,
        ...(kind === 'agent' ? { strategySha256: sha } : {}), label: label.trim(), locale });
      onCreated(r.mandate.id);
    } catch (e) { setFail(onError(e)); } finally { setBusy(false); }
  };
  const money = (k: keyof typeof n, testid: string) => <Field label={t(`rkM_${k}` as Key)} hint={t(`rkMH_${k}` as Key)}>
    <input className={inputCls} inputMode="decimal" autoComplete="off" value={n[k]} onChange={(e) => setN({ ...n, [k]: sanitizeAmountText(e.target.value) })} data-testid={testid} /><AmountProblem text={n[k]} /></Field>;
  const whole = (value: string, on: (s: string) => void, testid: string) => <input className={inputCls} inputMode="numeric" autoComplete="off" value={value} onChange={(e) => on(e.target.value.replace(/\D/g, ''))} data-testid={testid} />;
  const check = (id: string, on: boolean, flip: () => void, text: string, testid: string) => <label key={id} className="flex min-h-11 cursor-pointer items-center gap-3"><input type="checkbox" checked={on} onChange={flip} className="h-[18px] w-[18px] shrink-0 accent-blue" data-testid={testid} /><span className="break-all text-[14px]">{text}</span></label>;

  return (
    <Sheet title={t('rkNewTitle')} onClose={onClose} busy={busy} wide testid="rk-new"
      footer={<Btn full busy={busy} disabled={problems.length > 0} onClick={() => void create()} data-testid="rk-new-create">{t('rkCreate')}</Btn>}>
      <div className="space-y-4">
        <Notice tone="info">{t('rkNewBody')}</Notice>
        <Seg label={t('rkM_principal')} value={kind} options={[['api_key', t('rkM_key')], ['agent', t('rkM_agent')]]} onChange={setKind} />
        <Field label={t('rkM_principal')} hint={principals.length === 0 ? t(kind === 'api_key' ? 'rkM_noKeys' : 'rkM_noAgents') : undefined}>
          <select className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)} data-testid="rk-new-principal"><option value="">—</option>{principals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        {kind === 'agent' && <Field label={t('rkM_strategy')} hint={t('rkMH_strategy')}><input className={`${inputCls} font-mono text-[12.5px]`} autoCapitalize="none" spellCheck={false} value={sha} onChange={(e) => setSha(e.target.value.trim().toLowerCase())} data-testid="rk-new-sha" /></Field>}
        <Seg label={t('rkM_mode')} value={mode} options={[['paper', t('rkModePaper')], ['live', t('rkModeLive')]]} onChange={setMode} />
        {mode === 'live' && <Notice tone="warn">{t('rkM_liveNote')}</Notice>}
        <Field label={t('rkM_account')} hint={accounts.length === 0 ? t(mode === 'live' ? 'rkM_noLive' : 'rkM_noPaper') : undefined}>
          <select className={inputCls} value={account} onChange={(e) => { setAccount(e.target.value); setInst([]); }} data-testid="rk-new-account"><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        {acc && <Field label={t('rkM_instruments')} hint={t(mode === 'live' ? 'rkMH_instLive' : 'rkMH_instPaper')}>
          {pinned.length > 0 && pinned.length <= 12 ? <div data-testid="rk-new-instruments">{pinned.map((i) => check(i, inst.includes(i), () => toggle(inst, setInst, i), i, `rk-new-inst-${i}`))}</div>
            : <div className="space-y-2" data-testid="rk-new-instruments">
              <div className="grid grid-cols-[1fr_auto] gap-2"><input className={inputCls} list="rk-inst-list" autoCapitalize="none" spellCheck={false} value={instText} placeholder={`${acc.venue}:BTC`} onChange={(e) => setInstText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInst(); } }} data-testid="rk-new-inst-text" />
                <Btn kind="soft" onClick={addInst} data-testid="rk-new-inst-add"><Icon n="plus" className="h-4 w-4" />{t('rkAdd')}</Btn></div>
              <datalist id="rk-inst-list">{pinned.slice(0, 400).map((i) => <option key={i} value={i} />)}</datalist>
              <div className="flex flex-wrap gap-1.5">{inst.map((i) => <button key={i} type="button" className="rounded-full bg-elev px-3 py-1.5 font-mono text-[12.5px]" onClick={() => setInst(inst.filter((x) => x !== i))} aria-label={`${t('rkRemove')} ${i}`}>{i} ×</button>)}</div></div>}
        </Field>}
        <Field label={t('rkM_orderTypes')}><div className="grid grid-cols-2">{ORDER_TYPES.map((o) => check(o, types.includes(o), () => toggle(types, setTypes, o), t(`rkOT_${o}` as Key), `rk-new-type-${o}`))}</div></Field>
        {money('maxCapitalUsd', 'rk-new-capital')}{money('maxOrderNotionalUsd', 'rk-new-order')}{money('maxPositionNotionalUsd', 'rk-new-position')}{money('maxLeverage', 'rk-new-leverage')}{money('maxDailyLossUsd', 'rk-new-dailyloss')}{money('floorEquityUsd', 'rk-new-floor')}
        <Field label={t('rkM_days')} hint={t('rkMH_days', { n: dMax })}>{whole(days, setDays, 'rk-new-days')}{INT.test(days) && Number(days) > dMax && <span role="alert" className="mt-1.5 block text-[12.5px] text-danger">{t('rkMH_days', { n: dMax })}</span>}</Field>
        <Field label={t('rkM_frequency')} hint={t('rkMH_frequency')}><div className="grid grid-cols-3 gap-2">
          {whole(freq.perMinute, (s) => setFreq({ ...freq, perMinute: s }), 'rk-new-permin')}{whole(freq.perHour, (s) => setFreq({ ...freq, perHour: s }), 'rk-new-perhour')}{whole(freq.perDay, (s) => setFreq({ ...freq, perDay: s }), 'rk-new-perday')}</div></Field>
        <Field label={t('rkM_slippage')} hint={t('rkMH_slippage')}>{whole(slip, setSlip, 'rk-new-slippage')}</Field>
        {money('maxFeeUsd', 'rk-new-fee')}
        <fieldset className="space-y-3"><legend className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('rkM_stops')}</legend>
          <p className="text-[12.5px] leading-snug text-mute">{t('rkMH_stops')}</p>
          {STOPS.map((s) => <Field key={s.kind} label={t(`rkStop_${s.kind}` as Key)}><input className={inputCls} inputMode={s.dec ? 'decimal' : 'numeric'} value={stops[s.kind] ?? ''} placeholder={t('rkStopNone')} onChange={(e) => setStops({ ...stops, [s.kind]: s.dec ? sanitizeAmountText(e.target.value) : e.target.value.replace(/\D/g, '') })} data-testid={`rk-new-stop-${s.kind}`} /></Field>)}
        </fieldset>
        <Field label={t('rkM_label')}><input className={inputCls} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} data-testid="rk-new-label" /></Field>
        {problems.length > 0 && <p className="text-[12.5px] leading-snug text-mute" data-testid="rk-new-problems">{t('rkM_todo')} <span className="font-mono">{problems.join(', ')}</span></p>}
        {fail && <Notice tone="danger">{fail}</Notice>}
      </div></Sheet>);
}
