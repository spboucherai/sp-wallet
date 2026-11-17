// NFT delivery 2 — Send NFT (from the item page) and the Bitcoin "protected outputs" screen. One lazy chunk, loaded only when
// the owner opens one of the two.
//
// Rules of the Send flow:
//  - the review sheet and the summary shown while the passkey prompt is open are built from ON-CHAIN identifiers, in full:
//    network, standard, the program / contract called, contract or mint, token id, quantity, destination, fees. They come from
//    the server's review of the canonical intent — the very fields whose hash the passkey signs (shown as « empreinte »);
//  - what the CREATOR declares (name, image) is shown small, below, labelled « métadonnée du créateur, non vérifiée »; it is
//    never the title of what is approved;
//  - a blocked asset never reaches this screen (the item page shows its exact reason); a refusal of the preparation is shown
//    with its code-specific sentence, and nothing is asked of the passkey;
//  - after approval: pending → confirmed only at the chain's finality; `not_broadcast` is said as such, never as "sent".
import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post, type ApiError } from '../api';
import { hasText, useT, type Key } from '../i18n';
import { displayName, mediaUrl, STANDARD_KEY, unitsToText, type NftItem, type NftReview, type NftTransferView, type UtxoLocksView } from '../nft';
import { propError } from '../sv';
import { Addr, Btn, Card, Fact, Field, Icon, inputCls, NetworkIcon, Notice, PageTitle, Skeleton, Tag, testNotSent } from '../ui';
import { CopyId } from './Nft';

type T = ReturnType<typeof useT>;
const FLOW = ['pending_approval', 'signed', 'broadcast', 'confirming', 'finalized'];
/** the sentence of a refusal: by the server's code when the interface has one, else the server's own (English) sentence — never a guess */
const refusalText = (t: T, e: unknown): string => { const x = e as ApiError & { message?: string }; const code = (x?.code ?? '').replace(/^nft_transfer_/, '').replace(/^policy_/, 'policy_');
  return hasText(`nfWhy_${code}`) ? t(`nfWhy_${code}` as Key) : hasText(`nfTErr_${code}`) ? t(`nfTErr_${code}` as Key, { detail: x?.message ?? '' }) : `${x?.message ?? t('nfErrOther', { code })} (${x?.code ?? 'error'})`; };

/** The on-chain identity of what is being sent — the same block on the form, the review sheet and the passkey summary. */
function Identity({ r, t, testid }: { r: Pick<NftReview, 'networkName' | 'network' | 'standard' | 'method' | 'asset' | 'tokenId' | 'quantity' | 'program'>; t: T; testid: string }) {
  const evm = r.tokenId !== null;
  return <dl data-testid={testid}>
    <Fact k={t('network')}><span className="inline-flex items-center gap-2 font-semibold" data-testid="nft-send-network"><NetworkIcon net={r.network} size={20} />{r.networkName}</span></Fact>
    <Fact k={t('nfStandard')}><span data-testid="nft-send-standard">{t(STANDARD_KEY[r.standard] ?? 'nfStd_unknown')}</span></Fact>
    <Fact k={t(evm ? 'nfTContract' : 'nfTMintOrAsset')}><CopyId value={r.asset} label={t(evm ? 'nfTContract' : 'nfTMintOrAsset')} /></Fact>
    {evm && <Fact k={t('nfTokenId')}><CopyId value={r.tokenId!} label={t('nfTokenId')} /></Fact>}
    <Fact k={t('nfTQuantity')}><span className="font-mono text-[15px] font-semibold" data-testid="nft-send-quantity">{r.quantity}</span></Fact>
    <Fact k={t(evm ? 'nfTCalledContract' : 'nfTCalledProgram')}><span className="break-all font-mono text-[12.5px]" data-testid="nft-send-program">{r.program}</span><div className="mt-0.5 text-[12.5px] text-mute" data-testid="nft-send-method">{r.method}</div></Fact>
  </dl>;
}
/** What the creator declares: small, secondary, labelled unverified. */
function CreatorNote({ name, collection, imageId, t }: { name: string | null; collection: string | null; imageId: string | null; t: T }) {
  return <div className="flex items-center gap-3 rounded-2xl border border-dashed border-line p-3" data-testid="nft-send-creator">
    {imageId ? <img src={mediaUrl(imageId)} alt="" width={44} height={44} loading="lazy" referrerPolicy="no-referrer" className="h-11 w-11 shrink-0 rounded-lg bg-elev object-cover opacity-80" /> : <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-elev text-mute"><Icon n="eye" className="h-4 w-4" /></div>}
    <div className="min-w-0 text-[12.5px] text-mute"><div className="font-semibold uppercase tracking-wide" data-testid="nft-send-creator-label">{t('nfTCreatorUnverified')}</div>
      <div className="truncate">{name ?? t('nfNameUnavailable')}{collection ? ` · ${collection}` : ''}</div></div></div>;
}

export function NftSend({ item, onClose }: { item: NftItem; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const book = useQuery({ queryKey: ['book'], queryFn: () => get<{ id: string; network: string; address: string; label: string }[]>('/addressbook') });
  const [step, setStep] = useState<'form' | 'review' | 'track'>('form');
  const [to, setTo] = useState(''), [qty, setQty] = useState('1'), [idem, setIdem] = useState(() => crypto.randomUUID());
  const [prep, setPrep] = useState<{ proposal: NftTransferView; review: NftReview; options: unknown } | null>(null), [cur, setCur] = useState<NftTransferView | null>(null);
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [checked, setChecked] = useState(false);
  const multi = item.standard === 'erc1155', held = item.quantity, qtyOk = /^[1-9]\d{0,77}$/.test(qty) && (!multi || BigInt(qty) <= BigInt(held));
  useEffect(() => { window.scrollTo(0, 0); }, [step]);
  const live = useQuery({ queryKey: ['nft', 'transfer', cur?.id], enabled: step === 'track' && !!cur, refetchInterval: (q) => (['finalized', 'failed', 'replaced', 'expired', 'rejected', 'not_broadcast'].includes((q.state.data as NftTransferView | undefined)?.state ?? '') ? false : 4000), queryFn: () => get<NftTransferView>(`/nfts/transfer/${cur!.id}`) });
  const shown = step === 'track' ? live.data ?? cur : cur;
  useEffect(() => { if (shown?.state === 'finalized') { void qc.invalidateQueries({ queryKey: ['nft'] }); } }, [shown?.state]);
  const formIdentity = { network: item.chainId, networkName: item.chainId, standard: item.standard, method: item.transfer?.route ?? '', asset: item.contractAddress ?? item.mintAddress ?? item.assetId, tokenId: item.family === 'evm' ? item.tokenId : null, quantity: multi ? qty || '—' : '1', program: item.family === 'evm' ? item.contractAddress ?? '' : item.tokenProgram ?? '' };

  const review = async () => {
    setBusy('review'); setErr('');
    try { const r = await post<{ proposal: NftTransferView; review: NftReview; options: unknown }>('/nfts/transfer/prepare', { key: item.key, to: to.trim(), ...(multi ? { quantity: qty } : {}) }, { 'idempotency-key': idem });
      setPrep(r); setCur(r.proposal); setChecked(false); setStep('review'); }
    catch (e) { setErr(refusalText(t, e)); setIdem(crypto.randomUUID()); } finally { setBusy(''); }
  };
  const approve = async () => {
    if (!prep) return;
    setBusy('passkey'); setErr('');
    try {
      const assertion = await startAuthentication({ optionsJSON: prep.options as never }); // challenge = fingerprint of this exact NFT transfer
      setBusy('submit');
      setCur(await post<NftTransferView>(`/nfts/transfer/${prep.proposal.id}/approve`, { assertion }));
      setStep('track');
    } catch (e) {
      setErr(refusalText(t, e));
      const fresh = await get<NftTransferView>(`/nfts/transfer/${prep.proposal.id}`).catch(() => null);
      if (fresh) { setCur(fresh); if (fresh.state !== 'pending_approval') setStep('track'); }
    } finally { setBusy(''); }
  };
  const cancel = async () => { if (prep && cur?.state === 'pending_approval') await post(`/transfers/proposals/${prep.proposal.id}/reject`).catch(() => {}); setPrep(null); setCur(null); setIdem(crypto.randomUUID()); setStep('form'); };
  const back = <button onClick={() => (step === 'review' ? void cancel() : onClose())} className="press -ml-1 inline-flex min-h-11 items-center gap-1 text-[14px] text-blue" data-testid="nft-send-back"><Icon n="back" className="h-4 w-4" />{t('back')}</button>;

  if (step === 'form') return <div className="space-y-4" data-testid="nft-send-form">
    {back}<PageTitle>{t('nfTTitle')}</PageTitle>
    <Card><Identity r={formIdentity} t={t} testid="nft-send-identity" /></Card>
    <CreatorNote name={displayName(item)} collection={item.collection?.name ?? null} imageId={(item.media.find((m) => m.role === 'image') ?? item.media[0])?.id ?? null} t={t} />
    {(item.transfer?.warnings ?? []).map((w) => <Notice key={w} tone="warn"><span data-testid={`nft-send-warn-${w}`}>{t(`nfTWarn_${w}` as Key)}</span></Notice>)}
    <Card className="space-y-4">
      <Field label={t('nfTRecipient')} hint={t('nfTRecipientHint', { network: item.chainId })}>
        <input className={`${inputCls} font-mono text-[13.5px]`} value={to} onChange={(e) => setTo(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" aria-label={t('nfTRecipient')} data-testid="nft-send-to" /></Field>
      {(book.data ?? []).some((b) => b.network === item.chainId) && <div className="flex flex-wrap gap-2" data-testid="nft-send-book">{book.data!.filter((b) => b.network === item.chainId).map((b) => <button key={b.id} type="button" onClick={() => setTo(b.address)} className={`press min-h-11 rounded-full border px-3.5 py-1.5 text-[13px] ${to === b.address ? 'border-emerald bg-emerald/[0.07] text-emerald' : 'border-line'}`}><Icon n="book" className="mr-1 inline h-3.5 w-3.5" />{b.label}</button>)}</div>}
      {multi && <Field label={t('nfTQuantity')} hint={t('nfTQuantityHint', { held })}>
        <input className={`${inputCls} text-[19px] font-semibold`} inputMode="numeric" pattern="[0-9]*" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 78))} aria-label={t('nfTQuantity')} aria-invalid={!qtyOk} data-testid="nft-send-qty" />
        {!qtyOk && qty !== '' && <p className="mt-1 text-[12.5px] text-warn" role="alert" data-testid="nft-send-qty-problem">{t('nfTQuantityProblem', { held })}</p>}</Field>}
      {err && <Notice tone="danger"><span role="alert" data-testid="nft-send-error">{err}</span></Notice>}
      <Btn full busy={busy === 'review'} disabled={!to.trim() || !qtyOk} onClick={review} data-testid="nft-send-review">{busy === 'review' ? t('nfTVerifying') : t('review')}</Btn>
      <p className="text-[12.5px] text-mute">{t('nfTReviewNote')}</p>
    </Card>
  </div>;

  if (!shown) return null;
  if (step === 'review' && prep) { const r = prep.review, needCheck = r.warnings.some((w) => ['new_destination', 'address_poisoning_suspected', 'contract_recipient'].includes(w));
    const fee = (v: string) => `${unitsToText(v, r.fee.decimals)} ${r.fee.symbol}`;
    return <div className="space-y-4" data-testid="nft-send-reviewsheet">
      {back}<PageTitle>{t('nfTReviewTitle')}</PageTitle>
      {/* the receipt the passkey signs: on-chain identifiers, every one in full */}
      <Card className="receipt space-y-1">
        <p className="text-[13px] text-mute">{t('nfTYouSend')}</p>
        <Identity r={r} t={t} testid="nft-review-identity" />
        <dl>
          <Fact k={t('to')}><span data-testid="nft-review-to"><Addr value={r.to} /></span><div className="mt-1"><Tag tone={r.toKind === 'contract' ? 'warn' : 'mute'} testid="nft-review-tokind">{t(`nfTToKind_${r.toKind}` as Key)}</Tag></div></Fact>
          <Fact k={t('from')}><span className="break-all font-mono text-[12.5px] text-mute" data-testid="nft-review-from">{r.from}</span></Fact>
          <Fact k={t('fee')}><span data-testid="nft-review-fee">≈ {fee(r.fee.estimate)}</span></Fact>
          <Fact k={t('feeMax')}><span data-testid="nft-review-feemax">{fee(r.fee.max)}</span></Fact>
          {r.fee.rent !== null && r.fee.rent !== '0' && <Fact k={t('nfTRent')}><span data-testid="nft-review-rent">{fee(r.fee.rent)}</span></Fact>}
          {prep.proposal.intentHash && <Fact k={t('fingerprint')}><span className="break-all font-mono text-[11px] text-mute" data-testid="nft-review-hash">{prep.proposal.intentHash}</span></Fact>}
        </dl>
      </Card>
      <CreatorNote name={r.creatorMetadata.name} collection={r.creatorMetadata.collectionName} imageId={r.creatorMetadata.imageId} t={t} />
      <Card><p className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-emerald" data-testid="nft-review-sim"><Icon n="check" className="h-4 w-4" />{t('nfTSimOk')}</p>
        <ul className="space-y-1 text-[13px]" data-testid="nft-review-changes">{r.simulation.changes.map((c, k) => <li key={k} className="break-words"><span className="text-mute">{c.what} :</span> <span className="font-mono text-[12px]">{c.before}</span> → <span className="font-mono text-[12px]">{c.after}</span></li>)}</ul>
        <p className="mt-2 text-[12.5px] text-mute" data-testid="nft-review-verified">{t('nfTVerified', { n: r.verified.endpoints })} {r.verified.standard}; {r.verified.ownership}.</p>
        {r.accounts.length > 0 && <details className="mt-2 text-[12.5px]"><summary className="cursor-pointer text-blue" data-testid="nft-review-accounts-toggle">{t('nfTAccounts', { n: r.accounts.length })}</summary>
          <ul className="mt-2 space-y-1" data-testid="nft-review-accounts">{r.accounts.map((a, k) => <li key={k} className="break-all"><span className="text-mute">{a.role} ({t(`nfTAcct_${a.derived}` as Key)}) :</span> <span className="font-mono text-[11.5px]">{a.address}</span></li>)}</ul></details>}
      </Card>
      {r.warnings.map((w) => <Notice key={w} tone={w === 'address_poisoning_suspected' ? 'danger' : 'warn'}><span data-testid={`nft-review-warn-${w}`}>{hasText(`nfTWarn_${w}`) ? t(`nfTWarn_${w}` as Key) : t(`w_${w}` as Key)}</span></Notice>)}
      <Notice tone="danger"><span data-testid="nft-review-irreversible">{t('nfTIrreversible')}</span></Notice>
      {needCheck && <label className="flex min-h-11 items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 text-[14px]"><input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--primary)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="nft-review-check" />{t('nfTIChecked')}</label>}
      {/* while the passkey prompt is open: what is being approved, in on-chain terms */}
      {busy === 'passkey' && <Card className="border-blue"><p className="mb-1 text-[13px] font-semibold" data-testid="nft-passkey-title">{t('nfTPasskeyTitle')}</p><Identity r={r} t={t} testid="nft-passkey-summary" />
        <dl><Fact k={t('to')}><span className="break-all font-mono text-[12.5px]">{r.to}</span></Fact><Fact k={t('feeMax')}>{fee(r.fee.max)}{r.fee.rent !== null && r.fee.rent !== '0' ? ` + ${fee(r.fee.rent)}` : ''}</Fact></dl></Card>}
      {err && <Notice tone="danger"><span role="alert" data-testid="nft-send-error">{err}</span></Notice>}
      <Btn full busy={!!busy} disabled={needCheck && !checked} onClick={approve} data-testid="nft-send-approve"><Icon n="key" />{busy === 'passkey' ? t('approving') : t('approve')}</Btn>
      <Btn full kind="ghost" disabled={!!busy} onClick={() => void cancel()} data-testid="nft-send-cancel">{t('cancel')}</Btn>
    </div>; }

  const idx = FLOW.indexOf(shown.state), bad = idx < 0, r = (shown.nft ?? prep?.review) as NftReview | undefined;
  return <div className="space-y-4" data-testid="nft-send-track" data-state={shown.state}>
    {back}<PageTitle>{t('nfTTrackTitle')}</PageTitle>
    <Card className="space-y-3">
      {r && <Identity r={r} t={t} testid="nft-track-identity" />}
      {r && <dl><Fact k={t('to')}><Addr value={r.to} /></Fact></dl>}
      {testNotSent(shown) && <Notice tone="warn"><span data-testid="nft-track-notsent">{t('nfTNotBroadcast')}</span></Notice>}
      {!bad && !testNotSent(shown) && <ol className="space-y-2.5" aria-label={t('status')} data-testid="nft-track-steps">{FLOW.slice(1).map((s, k) => { const done = idx > k + 1 || shown.state === 'finalized', now = idx === k + 1 && shown.state !== 'finalized';
        return <li key={s} className={`flex items-center gap-3 text-[14.5px] ${done ? 'text-emerald' : now ? 'text-ink' : 'text-mute'}`}><span className={`grid h-6 w-6 place-items-center rounded-full border ${done ? 'border-emerald' : now ? 'border-blue text-blue' : 'border-line'}`}><Icon n={done ? 'check' : now ? 'spin' : 'clock'} className="h-3.5 w-3.5" /></span>
          {t(`s_${s}` as Key)}{s === 'confirming' && shown.confirmations > 0 ? ` · ${shown.confirmations} ${t('confirmations')}` : ''}</li>; })}</ol>}
      {shown.state === 'finalized' && <Notice tone="ok"><span data-testid="nft-track-done">{t('nfTConfirmed')}</span></Notice>}
      {!bad && shown.state !== 'finalized' && !testNotSent(shown) && <p className="text-xs text-mute" data-testid="nft-track-pending">{t('nfTPendingNote')}</p>}
      {bad && !testNotSent(shown) && <Notice tone="danger"><span data-testid="nft-track-failed">{shown.error ? propError(t, shown as never) : t(`s_${shown.state}` as Key)}</span></Notice>}
      {shown.txid && <dl><Fact k={t('txid')}><span className="break-all font-mono text-[11.5px]" data-testid="nft-track-txid">{shown.txid}</span></Fact></dl>}
      {shown.explorer && !testNotSent(shown) && <a className="inline-flex min-h-11 items-center gap-1.5 text-sm text-blue" href={shown.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
    </Card>
    <Btn full kind="soft" onClick={onClose} data-testid="nft-send-close">{t('nfTBackToItem')}</Btn>
  </div>;
}

// ── Bitcoin: protected outputs (the signer's lock list, the ord report or the heuristic flags) ────────────────────────────
export function UtxoLocks({ network = 'bitcoin' }: { network?: string }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['utxo-locks', network], queryFn: () => get<UtxoLocksView>(`/utxo-locks?network=${network}`), staleTime: 15_000, retry: false });
  const [err, setErr] = useState(''), [busy, setBusy] = useState('');
  const change = useMutation({ mutationFn: async (v: { action: 'lock' | 'unlock'; reason: 'owner' | 'ord' | 'heuristic'; outpoints: string[] }) => {
    setErr(''); setBusy(v.outpoints.join(','));
    const p = await post<{ intent: unknown; options: unknown }>('/utxo-locks/prepare', { network, ...v });
    const assertion = await startAuthentication({ optionsJSON: p.options as never }); // challenge = fingerprint of this exact list change
    return post('/utxo-locks/approve', { intent: p.intent, assertion });
  }, onSuccess: () => void qc.invalidateQueries({ queryKey: ['utxo-locks', network] }), onError: (e) => setErr(`${(e as ApiError).message ?? ''} (${(e as ApiError).code ?? 'error'})`), onSettled: () => setBusy('') });
  const review = useMutation({ mutationFn: (v: { outpoint: string; ordinary: boolean }) => post('/utxo-locks/review', { network, ...v }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['utxo-locks', network] }) });
  if (q.isError) return <Notice tone="warn"><span data-testid="utxo-error">{t('nfUError')} ({(q.error as ApiError)?.code ?? 'error'})</span></Notice>;
  if (!q.data) return <Skeleton h="h-40" />;
  const d = q.data, sats = (v: number) => `${unitsToText(String(v), d.decimals)} ${d.symbol}`;
  const unprotected = d.utxos.filter((u) => !u.signerLock && u.excludedBy.some((r) => r.startsWith('ord_')));
  return <div className="space-y-3" data-testid="utxo-locks" data-mode={d.mode}>
    <Notice tone={d.mode === 'ord' ? 'info' : 'warn'}><span data-testid="utxo-mode">{t(`nfUMode_${d.mode}` as Key, { host: d.ordHost ?? '' })}</span></Notice>
    <Notice tone="info"><span data-testid="utxo-notransfer">{t('nfUNoTransfer')}</span></Notice>
    {!d.signerSupportsLocks && <Notice tone="warn">{t('nfUSignerOld')}</Notice>}
    {unprotected.length > 0 && d.signerSupportsLocks && <Btn full busy={change.isPending} onClick={() => change.mutate({ action: 'lock', reason: 'ord', outpoints: unprotected.map((u) => u.outpoint) })} data-testid="utxo-lock-all"><Icon n="key" />{t('nfULockAll', { n: unprotected.length })}</Btn>}
    {err && <Notice tone="danger"><span role="alert" data-testid="utxo-change-error">{err}</span></Notice>}
    <Card className="!p-0">{d.utxos.length === 0 ? <p className="p-5 text-[13.5px] text-mute" data-testid="utxo-empty">{t('nfUEmpty')}</p> : <ul className="divide-y divide-line" data-testid="utxo-list">{d.utxos.map((u) => <li key={u.outpoint} className="space-y-2 px-5 py-3.5" data-outpoint={u.outpoint} data-spendable={u.spendable} data-locked={!!u.signerLock}>
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="text-[15px] font-semibold">{sats(u.value)}</div><div className="break-all font-mono text-[11.5px] text-mute">{u.outpoint}</div></div>
        <Tag tone={u.signerLock ? 'ok' : u.spendable ? 'mute' : 'warn'} icon={u.signerLock ? 'key' : u.spendable ? 'check' : 'warn'} testid="utxo-state">{t(u.signerLock ? 'nfULocked' : u.spendable ? 'nfUSpendable' : 'nfUHeld')}</Tag></div>
      {u.excludedBy.length > 0 && <ul className="space-y-0.5 text-[12.5px] text-mute" data-testid="utxo-reasons">{u.excludedBy.map((r) => <li key={r} data-reason={r}>· {t(`nfUWhy_${r}` as Key)}</li>)}</ul>}
      {u.ord && u.ord.inscriptions.length > 0 && <p className="break-all font-mono text-[11px] text-mute">{u.ord.inscriptions.join(', ')}</p>}
      <div className="flex flex-wrap gap-2">
        {d.signerSupportsLocks && (u.signerLock
          ? <Btn kind="ghost" busy={busy === u.outpoint} onClick={() => change.mutate({ action: 'unlock', reason: 'owner', outpoints: [u.outpoint] })} data-testid="utxo-unlock"><Icon n="key" className="h-4 w-4" />{t('nfUUnlock')}</Btn>
          : <Btn kind="soft" busy={busy === u.outpoint} onClick={() => change.mutate({ action: 'lock', reason: u.excludedBy.some((r) => r.startsWith('ord_')) ? 'ord' : u.excludedBy.some((r) => r.startsWith('heuristic_')) ? 'heuristic' : 'owner', outpoints: [u.outpoint] })} data-testid="utxo-lock"><Icon n="key" className="h-4 w-4" />{t('nfULock')}</Btn>)}
        {!u.signerLock && u.excludedBy.length > 0 && u.excludedBy.every((r) => r.startsWith('heuristic_')) && <Btn kind="ghost" busy={review.isPending} onClick={() => review.mutate({ outpoint: u.outpoint, ordinary: !u.reviewed })} data-testid="utxo-review">{t(u.reviewed ? 'nfUUnreview' : 'nfUReview')}</Btn>}
      </div></li>)}</ul>}</Card>
    {d.staleLocks.length > 0 && <Card><p className="mb-2 text-[13px] text-mute">{t('nfUStale')}</p><ul className="space-y-2" data-testid="utxo-stale">{d.staleLocks.map((l) => <li key={l.outpoint} className="flex items-center justify-between gap-3"><span className="break-all font-mono text-[11.5px]">{l.outpoint}</span>
      <Btn kind="ghost" onClick={() => change.mutate({ action: 'unlock', reason: 'owner', outpoints: [l.outpoint] })}>{t('nfUUnlock')}</Btn></li>)}</ul></Card>}
  </div>;
}
