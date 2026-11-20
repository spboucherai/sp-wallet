import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { checkAddress, warmAddressCheck, type AddressVerdict } from '../addressCheck';
import { get, post } from '../api';
import { cancelDraft, DraftKey, proposalApplied, proposalGone } from '../approval';
import { ApprovalOutcomePanel, useApprovalOutcome, type KnownOutcome } from '../approvalUi';
import type { Tab } from '../App';
import { sendBlock, sendBlockKey, useNetworks, usePortfolio, useSettings, type Proposal } from '../hooks';
import { amountInputText, amountOf, sanitizeAmountText } from '../amount';
import { AmountProblem } from '../amountUi';
import { errText, I18n, useT, type Key } from '../i18n';
import { lifecycleDone, lifecycleOf } from '../lifecycle';
import { LifecycleExplain, LifecycleTimeline } from '../lifecycleUi';
import { addDecimal, cmpDecimal, fiatText, mulDecimal } from '../money';
import { Addr, Btn, Card, Chips, Coin, CopyBtn, EmptyState, exactAmt, Fact, Field, H, Icon, inputCls, NetworkIcon, Notice, PageTitle, Sheet, short, StatusPill, testNotSent, trimAmt } from '../ui';
import { contactFor, useContacts, type Contact } from '../wallet';
import { useFallbackInterval } from '../wallet-ui';
import { AgentRecipientNotice } from './AgentFund';

type Step = 'form' | 'review' | 'track';
/** warnings of a draft that the owner must acknowledge before the passkey: each has its own sentence next to its box */
export const ACK_WARNINGS = ['new_destination', 'address_poisoning_suspected', 'duplicate_recent', 'l1_fee_unknown'] as const;
const ACK_KEY: Record<(typeof ACK_WARNINGS)[number], Key> = { new_destination: 'iChecked', address_poisoning_suspected: 'iChecked', duplicate_recent: 'nwAckDuplicate', l1_fee_unknown: 'nwAckL1' };
/** the boxes a draft's warnings ask for (the two address warnings share one box): pure, tested */
export const acksFor = (warnings: readonly string[]): Key[] => [...new Set(ACK_WARNINGS.filter((w) => warnings.includes(w)).map((w) => ACK_KEY[w]))];
/**
 * « Max » of the NATIVE coin: the balance minus the fee ceiling of the last draft made on this network in this session — the
 * only fee figure the wallet has before a draft exists. Without one, the whole balance is proposed and SAID to be approximate:
 * the review computes the real fee and refuses an amount the balance cannot cover. Never negative. Exact decimal strings.
 */
export function maxNative(balance: string, feeCeiling: string | null): { value: string; approximate: boolean } {
  if (!feeCeiling) return { value: balance, approximate: true };
  const left = addDecimal(balance, `-${feeCeiling}`);
  return { value: left.startsWith('-') ? '0' : left, approximate: false };
}

export function Send({ go, initial }: { go: (t: Tab) => void; initial?: { network?: string; asset?: string; /** a destination to pre-fill (from a contact) */ view?: string } }) {
  const t = useT(); const qc = useQueryClient(); const { locale } = useContext(I18n); const { settings } = useSettings();
  const nets = useNetworks(), pf = usePortfolio(), contacts = useContacts();
  const [step, setStep] = useState<Step>('form');
  const [net, setNet] = useState(initial?.network ?? 'base'), [asset, setAsset] = useState(initial?.asset ?? ''), [to, setTo] = useState(initial?.view ?? ''), [amount, setAmount] = useState(''), [note, setNote] = useState(''), [memo, setMemo] = useState('');
  const [p, setP] = useState<Proposal | null>(null), [busy, setBusy] = useState(''), [err, setErr] = useState(''), [acks, setAcks] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState(false), [verdict, setVerdict] = useState<AddressVerdict | null>(null), [approxMax, setApproxMax] = useState(false);
  const fees = useRef<Record<string, string>>({});   // network → the fee ceiling of the last draft made there (for « Max » of the native coin)
  // NEXT W1: the same idempotency key for the same form content, whatever the number of retries; a new one when the content changes or once the server has answered
  const draft = useRef(new DraftKey()); const ap = useApprovalOutcome<Proposal>();
  const n = nets.data?.find((x) => x.id === net);
  const assets = useMemo(() => {
    if (!n) return [];
    const held = (id: string) => Number((pf.data?.balances.find((b) => b.network === n.id && b.asset === id)?.amount ?? '0') !== '0');
    return [n.native, ...n.tokens].sort((a, b) => held(b.id) - held(a.id) || Number(b.symbol === 'USDC') - Number(a.symbol === 'USDC'));
  }, [n, pf.data]);
  useEffect(() => { if (assets.length && !assets.some((a) => a.id === asset)) setAsset(assets[0]!.id); }, [assets, asset]);
  const bal = pf.data?.balances.find((b) => b.network === net && b.asset === asset);
  const a = assets.find((x) => x.id === asset);
  const fail = (e: unknown) => setErr(errText(t, e)); const block = sendBlock(pf.data);
  useEffect(() => { window.scrollTo(0, 0); }, [step]);   // each step starts at its top: the review is read from the amount down
  useEffect(() => { warmAddressCheck(); }, []);
  // NEXT: instant feedback on the address with the server's own rule (addressCheck.ts); the server still validates at the review
  useEffect(() => { setVerdict(null); const addr = to.trim(); if (!addr || !n) return; let live = true;
    const h = setTimeout(() => { void checkAddress(net, addr).then((v) => { if (live) setVerdict(v); }); }, 180);
    return () => { live = false; clearTimeout(h); }; }, [to, net, n]);

  // live status while tracking: the wallet event stream says when to re-read (walletEvents.ts); the timed re-read is the fallback
  const trackMs = useFallbackInterval(4000, 20_000);
  const live = useQuery({ queryKey: ['proposal', p?.id], enabled: step === 'track' && !!p, refetchInterval: (q) => (q.state.data && lifecycleDone(lifecycleOf(q.state.data)) ? false : trackMs), queryFn: () => get<Proposal>(`/transfers/proposals/${p!.id}`) });
  const cur = step === 'track' ? live.data ?? p : p;

  const review = async () => {
    setBusy('review'); setErr('');
    const body = { network: net, asset, to: to.trim(), amount: amountOf(amount, locale) ?? amount.trim(), note, ...(n?.memo && memo.trim() ? { memo: memo.trim() } : {}) };
    try { const d = await post<Proposal>('/transfers/proposals', body, { 'idempotency-key': draft.current.for(JSON.stringify(body)) }); if (d.maxFeeDisplay) fees.current[net] = d.maxFeeDisplay; setP(d); setAcks({}); setStep('review'); }
    catch (e) { fail(e); draft.current.failed(e); } finally { setBusy(''); }   // a lost answer keeps the key: the retry is the same request
  };
  const read = (id: string) => get<Proposal>(`/transfers/proposals/${id}`);
  // what the SERVER said of the approval (its answer, or the state read after a lost answer) decides what is shown
  const settle = (o: KnownOutcome<Proposal, Proposal>) => {
    if (o.kind === 'refused') { fail(o.error); const id = p?.id; if (id) void read(id).then((fresh) => { setP(fresh); if (proposalApplied(fresh)) setStep('track'); }, () => {}); return; }
    const s = o.kind === 'answered' ? o.value : o.state; setP(s);
    if (o.kind === 'read' && !o.applied) { setErr(''); return; }   // the panel says it: the server still awaits the approval
    setErr(''); setStep('track'); void qc.invalidateQueries({ queryKey: ['portfolio'] });
  };
  const approve = async () => {
    if (!p) return;
    setBusy('prepare'); setErr('');
    let assertion;
    try {   // nothing has been approved yet: a failure here is an ordinary error, the review stays
      const ra = await post<{ proposal: Proposal; options: any }>(`/transfers/proposals/${p.id}/request-approval`);
      setP(ra.proposal); setBusy('passkey');
      assertion = await startAuthentication({ optionsJSON: ra.options }); // challenge = fingerprint of this exact transfer
    } catch (e) {
      fail(e);
      const fresh = await read(p.id).catch(() => null);
      if (fresh) { setP(fresh); if (proposalApplied(fresh)) setStep('track'); }
      setBusy(''); return;
    }
    // from here the approval LEAVES the browser: only a state read from the server says what happened (approval.ts)
    setBusy('submit');
    await ap.run({ submit: () => post<Proposal>(`/transfers/proposals/${p.id}/approve`, { assertion }, undefined, { interaction: true }), read: () => read(p.id), applied: proposalApplied }, settle);
    setBusy('');
  };
  const reset = () => { setStep('form'); setP(null); setTo(''); setAmount(''); setNote(''); setMemo(''); setErr(''); setApproxMax(false); draft.current.renew(); };
  // a cancellation that fails says so and changes nothing on screen; it is not offered once the approval was submitted
  const cancel = async () => {
    if (!p) { reset(); return; }
    setBusy('cancel'); setErr('');
    const c = await cancelDraft(() => post(`/transfers/proposals/${p.id}/reject`), () => read(p.id));
    setBusy('');
    if (c.kind === 'cancelled' || (c.state && proposalGone(c.state))) { reset(); return; }
    setErr(t('nxCancelFailed', { why: errText(t, c.error) }));
    if (c.state) { setP(c.state); if (proposalApplied(c.state)) setStep('track'); }
  };

  // v9: where the owner is in the flow (details → review → tracking); the current step is named, not only coloured
  const steps = <ol className="flex flex-wrap items-center gap-2" aria-label={t('dsSteps')} data-testid="send-steps">{(['form', 'review', 'track'] as const).map((id, k) => { const cur = id === step, done = ['form', 'review', 'track'].indexOf(step) > k;
    return <li key={id} aria-current={cur ? 'step' : undefined} className={`t-footnote flex items-center gap-2 ${cur ? 'font-semibold text-ink' : 'text-mute'} ${k < 2 ? 'flex-1' : ''}`}>
      <span className={`t-micro grid h-6 w-6 shrink-0 place-items-center rounded-full font-bold ${cur ? 'bg-primary text-onprimary' : done ? 'bg-positive/15 text-positive' : 'bg-elev text-mute'}`}>{done ? <Icon n="check" className="h-3.5 w-3.5" /> : k + 1}</span>
      <span className="whitespace-nowrap">{t(id === 'form' ? 'dsStepDetails' : id === 'review' ? 'dsStepReview' : 'dsStepTrack')}</span>{k < 2 && <span className="h-px min-w-3 flex-1 bg-line" aria-hidden="true" />}</li>; })}</ol>;
  if (step === 'form') {
    const cur = settings.currency, ck = cur === 'USD' ? 'usd' : 'cad', price = a ? pf.data?.prices?.[a.symbol]?.[ck] : undefined;
    const typed = amountOf(amount, locale), equiv = typed && price !== undefined ? mulDecimal(typed, price) : null;
    const over = typed !== null && bal?.display != null && cmpDecimal(typed, bal.display) > 0;
    const contact = contactFor(contacts.data, net, verdict?.ok ? verdict.normalized : to.trim()), mine = (contacts.data ?? []).filter((c) => c.network === net);
    // format only, while the checker is not there: a 0x address of 40 hex digits (the server and the signer validate for real at review)
    const evmOk = verdict === null && n?.family === 'evm' && to ? /^0x[0-9a-fA-F]{40}$/.test(to) : null;
    const setMax = () => { if (bal?.display == null) return; if (asset !== 'native') { setAmount(amountInputText(bal.display, locale)); setApproxMax(false); return; }
      const m = maxNative(bal.display, fees.current[net] ?? null); setAmount(amountInputText(m.value, locale)); setApproxMax(true); };
    return (
      <div className="space-y-4" data-testid="send">
        <PageTitle>{t('sendTitle')}</PageTitle>
        <div className="reading">{steps}</div>
        {/* NEXT W5: the same rule as on Home and on an asset's page — no transfer while halted or while the signer cannot be reached, and why */}
        {block === 'halted' && <Notice tone="danger">{t('haltedBanner')}</Notice>}
        {block === 'signer' && <Notice tone="warn"><span data-testid="send-blocked">{t(sendBlockKey(block))}</span></Notice>}
        {nets.data && !n && <Notice tone="warn"><span data-testid="send-net-not-found">{t('nxNetNotFoundBody', { net })}</span></Notice>}
        <div className="panes space-y-4 lg:space-y-0">
          <Card className="space-y-4">
            <div><div className="t-footnote mb-2 text-mute">{t('network')}</div>
              <Chips label={t('network')} value={net} onChange={(v) => { setNet(v); setTo(''); setMemo(''); setApproxMax(false); }} options={(nets.data ?? []).map((x) => ({ id: x.id, label: x.name, net: x.id }))} /></div>
            <div><div className="t-footnote mb-2 text-mute">{t('asset')}</div>
              <Chips label={t('asset')} value={asset} onChange={(v) => { setAsset(v); setApproxMax(false); }} options={assets.map((x) => ({ id: x.id, label: x.symbol, sym: x.symbol }))} /></div>
            <div>
              <div className="mb-1.5 flex items-end justify-between gap-3"><label htmlFor="send-to" className="t-footnote font-medium text-mute">{t('destination')}</label>
                <button type="button" className="link -my-2" onClick={() => setPicker(true)} data-testid="send-contacts"><Icon n="users" className="h-4 w-4" />{t('nwContacts')}{mine.length > 0 ? ` (${mine.length})` : ''}</button></div>
              <textarea id="send-to" className={`${inputCls} t-mono min-h-[5.25rem] resize-none break-all`} value={to} onChange={(e) => setTo(e.target.value.replace(/\s/g, ''))} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" aria-describedby="send-to-msg" aria-invalid={verdict?.ok === false || undefined} />
              <div id="send-to-msg" className="t-footnote mt-1.5 min-h-[1.25rem]" aria-live="polite">
                {verdict?.ok === true && <p className="flex items-center gap-1.5 text-positive" data-testid="addr-valid"><Icon n="check" className="h-3.5 w-3.5 shrink-0" />{t('nwAddrValid', { net: n?.name ?? net })}</p>}
                {verdict?.ok === false && <p className="flex items-center gap-1.5 text-negative" role="alert" data-testid="addr-invalid"><Icon n="warn" className="h-3.5 w-3.5 shrink-0" />{t('nwAddrInvalid', { net: n?.name ?? net })}</p>}
                {evmOk !== null && <p data-testid="addr-format" className={`flex items-center gap-1.5 ${evmOk ? 'text-positive' : 'text-mute'}`}><Icon n={evmOk ? 'check' : 'clock'} className="h-3.5 w-3.5" />{evmOk ? t('dsAddrFormatOk') : t('dsAddrFormatPartial', { n: to.length })}</p>}
                {contact && <p className="mt-1 flex items-center gap-1.5 font-semibold text-ink" data-testid="send-contact"><Icon n="book" className="h-3.5 w-3.5 shrink-0" />{t('nwSendContact', { label: contact.label })}</p>}
              </div>
            </div>
            {n?.family === 'evm' && <AgentRecipientNotice to={to} network={net} networkName={n.name} />}
            <Field label={`${t('amount')} (${a?.symbol ?? ''})`}>
              <div className="flex gap-2">
                <input className={`${inputCls} t-headline`} inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => { setAmount(sanitizeAmountText(e.target.value)); setApproxMax(false); }} autoComplete="off" aria-invalid={over || undefined} />
                {bal?.display != null && bal.amount !== '0' && <Btn kind="soft" onClick={setMax} data-testid="send-max">{t('max')}</Btn>}
              </div>
              <AmountProblem text={amount} />
              <span className="t-footnote mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="text-mute" data-testid="send-available">{bal?.display != null ? <>{t('available')}{locale === 'fr' ? ' : ' : ': '}<b className="font-semibold text-ink">{trimAmt(bal.display, 8)} {bal.symbol}</b></> : bal ? <span className="text-caution">{t('qaBalUnknown')}</span> : null}</span>
                {equiv !== null && <span className="text-mute" data-testid="send-fiat">≈ {fiatText(equiv, cur, locale)}</span>}</span>
              {over && <span className="t-footnote mt-1 block text-negative" role="alert" data-testid="send-over">{t('nwOverBalance')}</span>}
              {approxMax && <span className="t-footnote mt-1 block text-caution" data-testid="send-max-note">{t(asset === 'native' && !fees.current[net] ? 'nwMaxApprox' : 'nwMaxNet')}</span>}
            </Field>
            {n?.memo && <Field label={t(n.memo === 'uint32' ? 'memoTag' : 'memoText')} hint={t('memoWarn')}>
              <input className={inputCls} value={memo} maxLength={n.memo === 'uint32' ? 10 : n.id === 'stellar' ? 28 : 120} inputMode={n.memo === 'uint32' ? 'numeric' : 'text'} onChange={(e) => setMemo(n.memo === 'uint32' ? e.target.value.replace(/\D/g, '') : e.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></Field>}
            <Field label={t('note')}><input className={inputCls} value={note} maxLength={80} onChange={(e) => setNote(e.target.value)} /></Field>
            {err && <Notice tone="danger" testid="send-error">{err}</Notice>}
            <Btn full busy={busy === 'review'} disabled={!to || !amountOf(amount, locale) || block !== null || !n || verdict?.ok === false} onClick={review} data-testid="send-review">{busy === 'review' ? t('preparing') : t('review')}</Btn>
          </Card>
          <div className="min-w-0 space-y-4">
            {/* v8-cardano-polkadot: chain rules the amount must respect (the server enforces them and explains a refusal) */}
            {n?.family === 'cardano' && <Notice tone="info">{t('cdSendHint')}</Notice>}
            {n?.family === 'polkadot' && <Notice tone="info">{t('dtSendHint', { amount: trimAmt(n.activation ?? '0.01', 12) })}</Notice>}
            <Card><H>{t('nwSendHow')}</H><ol className="t-callout reading list-decimal space-y-2 pl-5 text-mute"><li>{t('nwSendHow1')}</li><li>{t('nwSendHow2')}</li><li>{t('nwSendHow3')}</li></ol></Card>
            {mine.length > 0 && <Card className="!px-0 !pb-1"><div className="px-[var(--card-padding)]"><H>{t('addressBook')}</H></div>
              <ul data-testid="send-book">{mine.slice(0, 5).map((c) => <li key={c.id}><button type="button" onClick={() => setTo(c.address)} aria-pressed={to === c.address} className={`row row-press ${to === c.address ? 'bg-elev/50' : ''}`}>
                <span className="disc" data-tone={to === c.address ? 'positive' : undefined} aria-hidden="true"><Icon n={to === c.address ? 'check' : 'book'} className="h-[1.125rem] w-[1.125rem]" /></span>
                <span className="min-w-0 flex-1"><span className="t-body-strong block truncate">{c.label}</span><span className="t-footnote block truncate font-mono text-mute">{short(c.address)}</span></span></button></li>)}</ul></Card>}
          </div>
        </div>
        {picker && <ContactPicker contacts={mine} netName={n?.name ?? net} current={to} onClose={() => setPicker(false)} onPick={(c) => { setTo(c.address); setPicker(false); }} onManage={() => go('contacts')} />}
      </div>
    );
  }

  if (!cur) return null;
  const need = acksFor(cur.warnings), acked = need.every((k) => acks[k]);
  if (step === 'review') return (
    <div className="page space-y-4" data-testid="send-review-step">
      <PageTitle>{t('reviewTitle')}</PageTitle>
      {steps}
      {/* the receipt the passkey signs: every field in full, nothing shortened, nothing animated */}
      <Card className="receipt">
        <div className="flex items-start gap-3.5 pb-3"><Coin sym={cur.symbol} net={cur.network} size={48} />
          <div className="min-w-0"><div className="t-footnote text-mute">{t('youSend')}</div>
          <div className="t-display amt text-[clamp(1.875rem,9.5vw,2.5rem)] !leading-[1.08]">{exactAmt(cur.amountDisplay)} <span className="text-mute">{cur.symbol}</span></div>
          <div className="t-mono mt-1 break-all text-mute">{cur.amount} {t('baseUnits')} · {cur.networkName}</div></div></div>
        <dl>
          <Fact stack k={t('to')}><Addr value={cur.to} /></Fact>
          {cur.memo && <Fact stack k={t('memo')}><span className="t-mono break-all">{cur.memo}</span></Fact>}
          <Fact stack k={t('from')}><span className="t-mono text-mute">{short(cur.from)}</span></Fact>
          <Fact stack k={t('network')}><span className="inline-flex items-center gap-2"><NetworkIcon net={cur.network} size={20} />{cur.networkName}</span></Fact>
          <Fact stack k={t('fee')}>{cur.feeDisplay ? `≈ ${trimAmt(cur.feeDisplay, 9)} ${cur.feeSymbol}` : '—'}</Fact>
          <Fact stack k={t('feeMax')}>{cur.maxFeeDisplay ? `${trimAmt(cur.maxFeeDisplay, 9)} ${cur.feeSymbol}` : '—'}</Fact>
          {cur.intentHash && <Fact stack k={t('fingerprint')}><span className="t-mono break-all text-mute">{cur.intentHash}</span></Fact>}
        </dl>
      </Card>
      <AgentRecipientNotice to={cur.to} network={cur.network} networkName={cur.networkName} />
      <Notice tone="ok">{t('simulated')}</Notice>
      {cur.warnings.map((w) => <Notice key={w} tone={w === 'address_poisoning_suspected' ? 'danger' : 'warn'} testid={`warning-${w}`}>{t(`w_${w}` as Key)}</Notice>)}
      <Notice tone="info">{t('boundNote')} {t('irreversible')}</Notice>
      {need.map((k) => <label key={k} className="ack-row" data-testid={`ack-${k}`}><input type="checkbox" checked={!!acks[k]} onChange={(e) => setAcks((x) => ({ ...x, [k]: e.target.checked }))} />{t(k)}</label>)}
      {err && !ap.locked && <Notice tone="danger">{err}</Notice>}
      <ApprovalOutcomePanel ap={ap} />
      {/* once the approval was submitted and until the server has said what happened: no Approve, no Cancel */}
      {!ap.locked && <Btn full busy={!!busy} disabled={!acked} onClick={approve} data-testid="send-approve"><Icon n="key" />{busy === 'passkey' ? t('approving') : busy === 'prepare' ? t('preparing') : t('approve')}</Btn>}
      {!ap.locked && busy !== 'submit' && <Btn full kind="ghost" disabled={!!busy} onClick={() => void cancel()} data-testid="send-cancel">{t('cancel')}</Btn>}
    </div>
  );

  const l = lifecycleOf(cur), known = contactFor(contacts.data, cur.network, cur.to), minConf = nets.data?.find((x) => x.id === cur.network)?.minConf;
  return (
    <div className="page space-y-4" data-testid="send-track">
      <PageTitle>{t('tracking')}</PageTitle>
      {steps}
      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><Coin sym={cur.symbol} net={cur.network} size={40} /><div className="min-w-0"><div className="t-title2 amt">{exactAmt(cur.amountDisplay)} {cur.symbol}</div><div className="t-footnote text-mute">{cur.networkName} → {known ? known.label : short(cur.to)}</div></div></div><StatusPill of={cur} /></div>
        {testNotSent(cur) ? <Notice tone="warn">{t('qaTestNotSent')}</Notice> : <LifecycleExplain of={cur} />}
        {!testNotSent(cur) && <LifecycleTimeline of={cur} minConf={minConf} />}
        {!lifecycleDone(l) && !testNotSent(cur) && l !== 'dropped' && l !== 'replaced' && <p className="t-footnote text-mute">{t('broadcastNote')}</p>}
        <dl>
          <Fact stack k={t('to')}>{known && <span className="block font-semibold">{known.label}</span>}<Addr value={cur.to} /></Fact>
          {cur.feePaidDisplay ? <Fact k={t('nwAcFeePaid')} testid="track-fee-paid">{exactAmt(cur.feePaidDisplay)} {cur.feeSymbol}</Fact> : cur.feeDisplay ? <Fact k={t('nwAcFeeEstimate')}>≈ {trimAmt(cur.feeDisplay, 9)} {cur.feeSymbol}</Fact> : null}
          {cur.txid && <Fact stack k={t('txid')}><span className="t-mono break-all">{cur.txid}</span>
            <div className="mt-2 flex flex-wrap gap-2"><CopyBtn small text={cur.txid} label={t('nxCopyHash')} />{cur.explorer && !testNotSent(cur) && <a className="btn press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-line px-5 text-[0.84375rem] font-medium" href={cur.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}</div></Fact>}
        </dl>
      </Card>
      {l === 'confirmed' && !known && <SaveAddr network={cur.network} address={cur.to} onSaved={() => { void qc.invalidateQueries({ queryKey: ['contacts'] }); void qc.invalidateQueries({ queryKey: ['book'] }); }} />}
      <div className="grid grid-cols-2 gap-3"><Btn kind="soft" onClick={reset}>{t('newTransfer')}</Btn><Btn kind="ghost" onClick={() => go('activity')}>{t('activity')}</Btn></div>
    </div>
  );
}

/** the contacts of the chosen network: search, pick — the address goes into the field, where it is shown in full */
function ContactPicker({ contacts, netName, current, onClose, onPick, onManage }: { contacts: Contact[]; netName: string; current: string; onClose: () => void; onPick: (c: Contact) => void; onManage: () => void }) {
  const t = useT(); const [q, setQ] = useState('');
  const s = q.trim().toLowerCase(), rows = contacts.filter((c) => !s || c.label.toLowerCase().includes(s) || c.address.toLowerCase().includes(s) || (c.note ?? '').toLowerCase().includes(s)).sort((x, y) => Number(y.favorite) - Number(x.favorite) || x.label.localeCompare(y.label));
  return <Sheet title={t('nwPickContact')} sub={netName} onClose={onClose} testid="contact-picker" footer={<Btn full kind="soft" onClick={() => { onClose(); onManage(); }}>{t('nwManageContacts')}</Btn>}>
    {contacts.length === 0 ? <EmptyState icon="users" title={t('nwPickNone', { net: netName })}>{t('nwCtEmptyBody')}</EmptyState> : <div className="space-y-3">
      <input className={inputCls} type="search" placeholder={t('nwCtSearch')} aria-label={t('nwCtSearch')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <ul className="-mx-[var(--card-padding)]">{rows.map((c) => <li key={c.id}><button type="button" className="row row-press" onClick={() => onPick(c)} aria-pressed={current === c.address} data-testid="pick-contact">
        <span className="disc" aria-hidden="true"><Icon n={c.favorite ? 'starFill' : 'book'} className="h-[1.125rem] w-[1.125rem]" /></span>
        <span className="min-w-0 flex-1"><span className="t-body-strong block truncate">{c.label}</span><span className="t-mono block break-all text-mute">{c.address}</span>{c.note && <span className="t-footnote block text-mute">{c.note}</span>}</span></button></li>)}</ul></div>}
  </Sheet>;
}
function SaveAddr({ network, address, onSaved }: { network: string; address: string; onSaved: () => void }) {
  const t = useT(); const [label, setLabel] = useState(''), [err, setErr] = useState('');
  return <Card><H>{t('saveAddress')}</H><div className="flex gap-2"><input className={inputCls} placeholder={t('label')} aria-label={t('label')} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
    <Btn kind="soft" disabled={!label.trim()} onClick={() => { setErr(''); void post('/addressbook', { network, address, label: label.trim() }).then(onSaved, (e) => setErr(errText(t, e))); }}>{t('save')}</Btn></div>{err && <p className="t-footnote mt-2 text-negative" role="alert">{err}</p>}</Card>;
}
