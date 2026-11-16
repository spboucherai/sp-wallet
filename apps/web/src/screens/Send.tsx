import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState } from 'react';
import { get, post } from '../api';
import type { Tab } from '../App';
import { useNetworks, usePortfolio, type Proposal } from '../hooks';
import { amountInputText, amountOf, sanitizeAmountText } from '../amount';
import { AmountProblem } from '../amountUi';
import { errText, I18n, useT, type Key } from '../i18n';
import { propError } from '../sv'; // v11: why a transfer ended, by code
import { Addr, Btn, Card, Chips, Coin, exactAmt, Field, H, Icon, inputCls, NetworkIcon, Notice, PageTitle, short, StatePill, testNotSent, trimAmt } from '../ui';
import { AgentRecipientNotice } from './AgentFund';

type Step = 'form' | 'review' | 'track';
const FLOW = ['pending_approval', 'signed', 'broadcast', 'confirming', 'finalized'];

export function Send({ go, initial }: { go: (t: Tab) => void; initial?: { network?: string; asset?: string } }) {
  const t = useT(); const qc = useQueryClient(); const { locale } = useContext(I18n);
  const nets = useNetworks(), pf = usePortfolio();
  const book = useQuery({ queryKey: ['book'], queryFn: () => get<{ id: string; network: string; address: string; label: string }[]>('/addressbook') });
  const [step, setStep] = useState<Step>('form');
  const [net, setNet] = useState(initial?.network ?? 'base'), [asset, setAsset] = useState(initial?.asset ?? ''), [to, setTo] = useState(''), [amount, setAmount] = useState(''), [note, setNote] = useState(''), [memo, setMemo] = useState('');
  const [p, setP] = useState<Proposal | null>(null), [busy, setBusy] = useState(''), [err, setErr] = useState(''), [checked, setChecked] = useState(false);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const n = nets.data?.find((x) => x.id === net);
  const assets = useMemo(() => {
    if (!n) return [];
    const held = (id: string) => Number((pf.data?.balances.find((b) => b.network === n.id && b.asset === id)?.amount ?? '0') !== '0');
    return [n.native, ...n.tokens].sort((a, b) => held(b.id) - held(a.id) || Number(b.symbol === 'USDC') - Number(a.symbol === 'USDC'));
  }, [n, pf.data]);
  useEffect(() => { if (assets.length && !assets.some((a) => a.id === asset)) setAsset(assets[0]!.id); }, [assets, asset]);
  const bal = pf.data?.balances.find((b) => b.network === net && b.asset === asset);
  const a = assets.find((x) => x.id === asset);
  const fail = (e: unknown) => setErr(errText(t, e));
  useEffect(() => { window.scrollTo(0, 0); }, [step]);   // each step starts at its top: the review is read from the amount down

  // live status while tracking
  const live = useQuery({ queryKey: ['proposal', p?.id], enabled: step === 'track' && !!p, refetchInterval: 4000, queryFn: () => get<Proposal>(`/transfers/proposals/${p!.id}`) });
  const cur = step === 'track' ? live.data ?? p : p;

  const review = async () => {
    setBusy('review'); setErr('');
    try { setP(await post<Proposal>('/transfers/proposals', { network: net, asset, to: to.trim(), amount: amountOf(amount, locale) ?? amount.trim(), note, ...(n?.memo && memo.trim() ? { memo: memo.trim() } : {}) }, { 'idempotency-key': idem })); setChecked(false); setStep('review'); }
    catch (e) { fail(e); setIdem(crypto.randomUUID()); } finally { setBusy(''); }
  };
  const approve = async () => {
    if (!p) return;
    setBusy('prepare'); setErr('');
    try {
      const ra = await post<{ proposal: Proposal; options: any }>(`/transfers/proposals/${p.id}/request-approval`);
      setP(ra.proposal); setBusy('passkey');
      const assertion = await startAuthentication({ optionsJSON: ra.options }); // challenge = fingerprint of this exact transfer
      setBusy('submit');
      setP(await post<Proposal>(`/transfers/proposals/${p.id}/approve`, { assertion }));
      setStep('track'); void qc.invalidateQueries({ queryKey: ['portfolio'] });
    } catch (e) {
      fail(e);
      const fresh = await get<Proposal>(`/transfers/proposals/${p.id}`).catch(() => null);
      if (fresh) { setP(fresh); if (!['draft', 'pending_approval'].includes(fresh.state)) setStep('track'); }
    } finally { setBusy(''); }
  };
  const reset = () => { setStep('form'); setP(null); setTo(''); setAmount(''); setNote(''); setMemo(''); setErr(''); setIdem(crypto.randomUUID()); };
  const cancel = async () => { if (p) await post(`/transfers/proposals/${p.id}/reject`).catch(() => {}); reset(); };

  // v9: where the owner is in the flow (details → review → tracking); the current step is named, not only coloured
  const steps = <ol className="flex items-center gap-2" aria-label={t('dsSteps')} data-testid="send-steps">{(['form', 'review', 'track'] as const).map((id, k) => { const cur = id === step, done = ['form', 'review', 'track'].indexOf(step) > k;
    return <li key={id} aria-current={cur ? 'step' : undefined} className={`flex items-center gap-2 text-[12.5px] ${cur ? 'font-semibold text-ink' : 'text-mute'} ${k < 2 ? 'flex-1' : ''}`}>
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11.5px] font-bold ${cur ? 'bg-primary text-onprimary' : done ? 'bg-emerald/15 text-emerald' : 'bg-elev text-mute'}`}>{done ? <Icon n="check" className="h-3.5 w-3.5" /> : k + 1}</span>
      <span className="whitespace-nowrap">{t(id === 'form' ? 'dsStepDetails' : id === 'review' ? 'dsStepReview' : 'dsStepTrack')}</span>{k < 2 && <span className="h-px min-w-3 flex-1 bg-line" aria-hidden="true" />}</li>; })}</ol>;
  // format only (the server and the signer validate for real at review): a 0x address of 40 hex digits
  const evmOk = n?.family === 'evm' && to ? /^0x[0-9a-fA-F]{40}$/.test(to) : null;
  if (step === 'form') return (
    <div className="space-y-4">
      <PageTitle>{t('sendTitle')}</PageTitle>
      {steps}
      {pf.data?.halted && <Notice tone="danger">{t('haltedBanner')}</Notice>}
      <Card className="space-y-4">
        <div><div className="mb-2 text-[13px] text-mute">{t('network')}</div>
          <Chips label={t('network')} value={net} onChange={(v) => { setNet(v); setTo(''); setMemo(''); }} options={(nets.data ?? []).map((x) => ({ id: x.id, label: x.name, net: x.id }))} /></div>
        <div><div className="mb-2 text-[13px] text-mute">{t('asset')}</div>
          <Chips label={t('asset')} value={asset} onChange={setAsset} options={assets.map((x) => ({ id: x.id, label: x.symbol, sym: x.symbol }))} /></div>
        <Field label={t('destination')}>
          <textarea className={`${inputCls} min-h-[84px] resize-none break-all font-mono text-[14px]`} value={to} onChange={(e) => setTo(e.target.value.replace(/\s/g, ''))} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
        </Field>
        {evmOk !== null && <p data-testid="addr-format" className={`-mt-2 flex items-center gap-1.5 text-[12.5px] ${evmOk ? 'text-emerald' : 'text-mute'}`}><Icon n={evmOk ? 'check' : 'clock'} className="h-3.5 w-3.5" />{evmOk ? t('dsAddrFormatOk') : t('dsAddrFormatPartial', { n: to.length })}</p>}
        {n?.family === 'evm' && <AgentRecipientNotice to={to} network={net} networkName={n.name} />}
        {(book.data ?? []).filter((b) => b.network === net).length > 0 && <div><div className="mb-1.5 text-[13px] text-mute">{t('addressBook')}</div>
          <div className="flex flex-wrap gap-2">{book.data!.filter((b) => b.network === net).map((b) => <button key={b.id} onClick={() => setTo(b.address)} className={`press min-h-11 rounded-full border px-3.5 py-1.5 text-[13px] ${to === b.address ? 'border-emerald bg-emerald/[0.07] text-emerald' : 'border-line'}`}><Icon n="book" className="mr-1 inline h-3.5 w-3.5" />{b.label} · {short(b.address)}</button>)}</div></div>}
        <Field label={`${t('amount')} (${a?.symbol ?? ''})`} hint={bal?.display != null ? <>{t('available')}{t('available') === 'Disponible' ? ' : ' : ': '}{trimAmt(bal.display, 8)} {bal.symbol}</> : bal ? <span className="text-warn">{t('qaBalUnknown')}</span> : undefined}>
          <div className="flex gap-2">
            <input className={`${inputCls} text-[19px] font-semibold`} inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(sanitizeAmountText(e.target.value))} autoComplete="off" />
            {asset !== 'native' && bal?.display != null && <Btn kind="soft" onClick={() => setAmount(amountInputText(bal.display!, locale))}>{t('max')}</Btn>}
          </div>
          <AmountProblem text={amount} />
        </Field>
        {n?.memo && <Field label={t(n.memo === 'uint32' ? 'memoTag' : 'memoText')} hint={t('memoWarn')}>
          <input className={inputCls} value={memo} maxLength={n.memo === 'uint32' ? 10 : n.id === 'stellar' ? 28 : 120} inputMode={n.memo === 'uint32' ? 'numeric' : 'text'} onChange={(e) => setMemo(n.memo === 'uint32' ? e.target.value.replace(/\D/g, '') : e.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></Field>}
        <Field label={t('note')}><input className={inputCls} value={note} maxLength={80} onChange={(e) => setNote(e.target.value)} /></Field>
        {/* v8-cardano-polkadot: chain rules the amount must respect (the server enforces them and explains a refusal) */}
        {n?.family === 'cardano' && <Notice tone="info">{t('cdSendHint')}</Notice>}
        {n?.family === 'polkadot' && <Notice tone="info">{t('dtSendHint', { amount: trimAmt(n.activation ?? '0.01', 12) })}</Notice>}
        {err && <Notice tone="danger">{err}</Notice>}
        <Btn full busy={busy === 'review'} disabled={!to || !amountOf(amount, locale) || !!pf.data?.halted} onClick={review}>{busy === 'review' ? t('preparing') : t('review')}</Btn>
      </Card>
    </div>
  );

  if (!cur) return null;
  const needCheck = cur.warnings.includes('new_destination') || cur.warnings.includes('address_poisoning_suspected');
  if (step === 'review') return (
    <div className="space-y-4">
      <PageTitle>{t('reviewTitle')}</PageTitle>
      {steps}
      {/* the receipt the passkey signs: every field in full, nothing shortened, nothing animated */}
      <Card className="receipt space-y-4" >
        <div className="flex items-start gap-3.5"><Coin sym={cur.symbol} net={cur.network} size={48} />
          <div className="min-w-0"><div className="text-[13px] text-mute">{t('youSend')}</div>
          <div className="t-display break-words text-[clamp(30px,9.5vw,40px)] !leading-[1.08]">{exactAmt(cur.amountDisplay)} <span className="text-mute">{cur.symbol}</span></div>
          <div className="mt-1 break-all font-mono text-xs text-mute">{cur.amount} {t('baseUnits')} · {cur.networkName}</div></div></div>
        <Row k={t('to')}><Addr value={cur.to} /></Row>
        <AgentRecipientNotice to={cur.to} network={cur.network} networkName={cur.networkName} />
        {cur.memo && <Row k={t('memo')}><span className="break-all font-mono text-[14px]">{cur.memo}</span></Row>}
        <Row k={t('from')}><span className="font-mono text-[13px] text-mute">{short(cur.from)}</span></Row>
        <Row k={t('network')}><span className="inline-flex items-center gap-2"><NetworkIcon net={cur.network} size={20} />{cur.networkName}</span></Row>
        <Row k={t('fee')}>{cur.feeDisplay ? `≈ ${trimAmt(cur.feeDisplay, 9)} ${cur.feeSymbol}` : '—'}</Row>
        <Row k={t('feeMax')}>{cur.maxFeeDisplay ? `${trimAmt(cur.maxFeeDisplay, 9)} ${cur.feeSymbol}` : '—'}</Row>
        {cur.intentHash && <Row k={t('fingerprint')}><span className="break-all font-mono text-[11px] text-mute">{cur.intentHash}</span></Row>}
      </Card>
      <Notice tone="ok">{t('simulated')}</Notice>
      {cur.warnings.map((w) => <Notice key={w} tone={w === 'address_poisoning_suspected' ? 'danger' : 'warn'}>{t(`w_${w}` as Key)}</Notice>)}
      <Notice tone="info">{t('boundNote')} {t('irreversible')}</Notice>
      {needCheck && <label className="flex min-h-11 items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 text-[14px]"><input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--primary)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{t('iChecked')}</label>}
      {err && <Notice tone="danger">{err}</Notice>}
      <Btn full busy={!!busy} disabled={needCheck && !checked} onClick={approve}><Icon n="key" />{busy === 'passkey' ? t('approving') : busy === 'prepare' ? t('preparing') : t('approve')}</Btn>
      <Btn full kind="ghost" disabled={!!busy} onClick={cancel}>{t('cancel')}</Btn>
    </div>
  );

  const idx = FLOW.indexOf(cur.state), bad = idx < 0;
  return (
    <div className="space-y-4">
      <PageTitle>{t('tracking')}</PageTitle>
      {steps}
      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><Coin sym={cur.symbol} net={cur.network} size={40} /><div className="min-w-0"><div className="break-words text-2xl font-semibold tracking-[-0.02em]">{exactAmt(cur.amountDisplay)} {cur.symbol}</div><div className="text-xs text-mute">{cur.networkName} → {short(cur.to)}</div></div></div>{testNotSent(cur) ? <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('qaSignedNotSent')}</span> : <StatePill state={cur.state} />}</div>
        {testNotSent(cur) && <Notice tone="warn">{t('qaTestNotSent')}</Notice>}
        {!bad && !testNotSent(cur) && <ol className="space-y-2.5" aria-label={t('status')}>{FLOW.slice(1).map((s, k) => { const done = idx > k + 1 || cur.state === 'finalized', now = idx === k + 1 && cur.state !== 'finalized';
          return <li key={s} className={`flex items-center gap-3 text-[14.5px] ${done ? 'text-emerald' : now ? 'text-ink' : 'text-mute'}`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full border ${done ? 'border-emerald' : now ? 'border-blue text-blue' : 'border-line'}`}><Icon n={done ? 'check' : now ? 'spin' : 'clock'} className="h-3.5 w-3.5" /></span>
            {t(`s_${s}` as Key)}{s === 'confirming' && cur.confirmations > 0 ? ` · ${cur.confirmations} ${t('confirmations')}` : ''}</li>; })}</ol>}
        {cur.error && bad && <Notice tone="danger">{propError(t, cur)}</Notice>}
        {!bad && cur.state !== 'finalized' && !testNotSent(cur) && <p className="text-xs text-mute">{t('broadcastNote')}</p>}
        {cur.txid && <Row k={t('txid')}><span className="break-all font-mono text-[11.5px]">{cur.txid}</span></Row>}
        {cur.explorer && !testNotSent(cur) && <a className="inline-flex min-h-11 items-center gap-1.5 text-sm text-blue" href={cur.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
      </Card>
      {cur.state === 'finalized' && !(book.data ?? []).some((b) => b.network === cur.network && b.address === cur.to) && <SaveAddr network={cur.network} address={cur.to} onSaved={() => void book.refetch()} />}
      <div className="grid grid-cols-2 gap-3"><Btn kind="soft" onClick={reset}>{t('newTransfer')}</Btn><Btn kind="ghost" onClick={() => go('activity')}>{t('activity')}</Btn></div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="border-t border-line pt-3"><div className="mb-0.5 text-[12.5px] text-mute">{k}</div><div>{children}</div></div>;
}
function SaveAddr({ network, address, onSaved }: { network: string; address: string; onSaved: () => void }) {
  const t = useT(); const [label, setLabel] = useState('');
  return <Card><H>{t('saveAddress')}</H><div className="flex gap-2"><input className={inputCls} placeholder={t('label')} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
    <Btn kind="soft" disabled={!label.trim()} onClick={() => void post('/addressbook', { network, address, label: label.trim() }).then(onSaved)}>{t('save')}</Btn></div></Card>;
}
