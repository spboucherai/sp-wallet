/**
 * The confirm sheet of every GMX operation (v8) — an order, the close of a position, the cancellation of a pending order:
 *   proposal (POST /orders | /positions/close | /orders/:opId/cancel, ONE Idempotency-Key per review) → the fields the passkey
 *   signs (`fields`) AND the ones the signer fixes itself (`fixed`), the intent hash, the expiry countdown → passkey →
 *   POST /operations/:id/approve → the operation, read from the server until the chain has said the last word.
 * Safety of the screen itself: the proposal is made once per key; the approve button exists only while the proposal is
 * approvable and equal to what was asked (and while the receivers the signer fixes are the wallet itself); « retirer »,
 * closing the sheet, an expiry or a failed passkey prompt WITHDRAWS the proposal on the server (no passkey needed); after the
 * approval the sheet says « en attente d'exécution par le réseau GMX » until the server reports the keeper's transaction.
 *
 * v10: the signed fields and the fixed fields are two receipts under their eyebrow titles — every row the server sent, in
 * its order, whole. The estimate is no longer behind a disclosure: it is always open. Nothing is animated.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useT, type Key } from '../i18n';
import { Btn, Fact, Icon, Notice, SkeletonCard } from '../ui';
import { D, dec, type DecStr } from './dec';
import { gapi, GMX_STATUS_KEY, gmxError, type GmxErr, type GmxOperation, type GmxOrderBody, type GmxPosition, type GmxPrepared, type GmxStatus } from './gmx';
import { EstimateRows, GMX_LABEL, GmxErrNotice, GmxOpCard, TwoStep } from './GmxBits';
import { Countdown, Fingerprint, Group, LiveSheet, ModeBand, TICKET, Waiting, WORDS } from './LiveBits';
import { newKey } from './live';

export type GmxRequest = { kind: 'order'; body: GmxOrderBody } | { kind: 'close'; position: GmxPosition; fraction: DecStr; slippageBps?: number } | { kind: 'cancel'; op: GmxOperation };
type Phase = 'proposing' | 'ready' | 'passkey' | 'sending' | 'progress' | 'void';
const same = (a: DecStr | null | undefined, b: DecStr | null | undefined) => { const x = dec(a), y = dec(b); return !!x && !!y && D.eq(x, y); };
const ADDR = /0x[0-9a-fA-F]{40}/;

/** What is on the sheet must be what was asked, and the money can only come back to the wallet. Returns null, or what differs. */
export function gmxIntegrity(r: GmxRequest, p: GmxPrepared, account: string | null): 'kind' | 'market' | 'side' | 'collateral' | 'target' | 'receiver' | 'fields' | null {
  const o = p.operation;
  if (r.kind === 'order') {
    if (o.kind !== r.body.action) return 'kind';
    if (o.market?.toLowerCase() !== r.body.market.toLowerCase()) return 'market';
    if (o.side !== r.body.side) return 'side';
    if (r.body.action === 'increase' && !same(o.collateral, r.body.collateral)) return 'collateral';
  } else if (r.kind === 'close') {
    if (o.kind !== 'decrease') return 'kind';
    if (o.market?.toLowerCase() !== r.position.market.toLowerCase()) return 'market';
    if (o.side !== r.position.side) return 'side';
  } else if (o.kind !== 'cancel' || o.targetOpId !== r.op.id) return 'target';
  if (!Array.isArray(p.fields) || !p.fields.length || !Array.isArray(p.fixed)) return 'fields';
  // the receivers are fixed by the signer: when the sheet is given an address for them, it must be the wallet's own
  for (const f of p.fixed) if (f.label === 'receiver' || f.label === 'cancellationReceiver') { const a = ADDR.exec(f.value)?.[0]; if (a && account && a.toLowerCase() !== account.toLowerCase()) return 'receiver'; }
  return null;
}

/** every row the server sent, in its order: the label in the screen's language (or as sent), the value whole */
function Fields({ rows, testid }: { rows: { label: string; value: string }[]; testid: string }) {
  const t = useT();
  return <dl className="receipt" data-testid={testid}>{rows.map((f) => { const k = `gxF_${f.label}`, name = t(k as Key); const long = f.value.length > 22;
    return <Fact key={f.label} k={<span data-label={f.label}>{name.startsWith('gxF') ? f.label : name}</span>}><span className={long ? 'break-all font-mono text-[11.5px] font-normal' : ''}>{f.value}</span></Fact>; })}</dl>;
}

export function GmxConfirm({ status, request, onClose }: { status: GmxStatus; request: GmxRequest; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const [key, setKey] = useState(() => newKey(`gmx-${request.kind}`));
  const [phase, setPhase] = useState<Phase>('proposing'), [p, setP] = useState<GmxPrepared | null>(null), [err, setErr] = useState<{ e: GmxErr; raw: unknown } | null>(null), [bad, setBad] = useState<string | null>(null), [opId, setOpId] = useState<string | null>(null);
  const started = useRef<string | null>(null), phaseRef = useRef<Phase>('proposing'), lock = useRef(false);
  phaseRef.current = phase;
  const refresh = () => { void qc.invalidateQueries({ queryKey: GMX_STATUS_KEY }); };
  const fail = (e: unknown) => setErr({ e: gmxError(e), raw: e });
  /** nothing approvable stays on the server once the screen has given up on a proposal (it expires by itself otherwise) */
  const withdraw = (id: string | undefined) => { if (id) void gapi.withdraw(id).catch(() => {}).finally(refresh); };

  const propose = async (k: string) => {
    setPhase('proposing'); setErr(null); setP(null); setBad(null);
    try {
      const r = request.kind === 'order' ? await gapi.order(request.body, k)
        : request.kind === 'close' ? await gapi.close({ market: request.position.market, side: request.position.side, fraction: request.fraction, ...(request.slippageBps ? { slippageBps: request.slippageBps } : {}) }, k)
        : await gapi.cancel(request.op.id);
      setP(r);
      if (r.operation.state !== 'pending_approval' || !r.options) { setOpId(r.operation.id); setPhase('progress'); return; }   // an answer for a key already used: show what that operation became
      const why = gmxIntegrity(request, r, status.account?.address ?? null);
      if (why) { setBad(why); setPhase('void'); withdraw(r.operation.id); return; }
      setPhase('ready');
    } catch (e) { fail(e); setPhase('void'); }
    finally { refresh(); }
  };
  useEffect(() => { if (started.current === key) return; started.current = key; void propose(key); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    if (lock.current || phaseRef.current !== 'ready' || !p) return;              // one prompt, one approval, however fast the button is pressed
    lock.current = true;
    try {
      setPhase('passkey'); setErr(null);
      let a: unknown;
      try { a = await startAuthentication({ optionsJSON: p.options }); }
      catch (e) { fail(e); setPhase('void'); withdraw(p.operation.id); return; }  // nothing was signed
      if (p.operation.expiresAt !== null && p.operation.expiresAt <= Date.now()) { setBad('expired'); setPhase('void'); withdraw(p.operation.id); return; }
      setPhase('sending');
      try { await gapi.approve(p.operation.id, a); } catch (e) { fail(e); }       // refused or lost: the operation itself says what happened
      setOpId(p.operation.id); setPhase('progress');
    } finally { lock.current = false; refresh(); }
  };
  const close = () => {
    if (phase === 'sending' || phase === 'passkey') return;                        // an approval is on its way: its answer must be seen
    if (phase === 'ready' || phase === 'proposing') withdraw(p?.operation.id);
    refresh(); onClose();
  };
  const op = useQuery({ queryKey: ['deriv', 'gmx', 'op', opId], enabled: !!opId && phase === 'progress', queryFn: () => gapi.operation(opId!), refetchInterval: (q) => (q.state.data?.final ? false : 2500), retry: 0 });
  useEffect(() => { refresh(); }, [op.data?.state]);   // eslint-disable-line react-hooks/exhaustive-deps

  const o = p?.operation, action = o?.kind === 'decrease' ? 'decrease' : 'increase';
  const title = t(request.kind === 'cancel' ? 'gxConfirmCancelTitle' : request.kind === 'close' ? 'gxConfirmCloseTitle' : 'gxConfirmTitle');
  return <LiveSheet title={title} tone="mainnet" label={GMX_LABEL} busy={phase === 'sending' || phase === 'passkey'} onClose={close}>
    <div className="min-w-0 space-y-4" data-testid="gmx-confirm" data-phase={phase} data-kind={request.kind}>
      <ModeBand tone="mainnet" label={GMX_LABEL} compact />
      {phase === 'proposing' && <Waiting className="py-6">{t('gxProposing')}</Waiting>}

      {p && o && phase !== 'proposing' && phase !== 'progress' && <div className={`space-y-4 ${phase === 'void' ? 'opacity-50' : ''}`}>
        <p className="text-[13.5px] leading-snug">{t(request.kind === 'cancel' ? 'gxConfirmIntroCancel' : request.kind === 'close' ? 'gxConfirmIntroClose' : 'gxConfirmIntro')}</p>
        <Group title={t('gxSignedExactly')}><div className={TICKET}><Fields rows={p.fields} testid="gmx-fields" /></div></Group>
        <Group title={t('gxFixedBySigner')}>
          <div className="rounded-[18px] border border-line px-4 py-1.5"><Fields rows={p.fixed} testid="gmx-fixed" /></div><p className="mt-1.5 text-[12px] leading-snug text-mute">{t('gxFixedNote')}</p></Group>
        {p.estimate && request.kind !== 'cancel' && <Group title={t('gxEstSummary')}><div className="rounded-[18px] border border-line px-4 py-3"><EstimateRows e={p.estimate} action={action} /></div></Group>}
        {o.needsApproval && <Notice tone="info"><div data-testid="gmx-needs-approval">{t('gxNeedsApproval')}</div></Notice>}
        <dl className="rounded-[18px] border border-line px-4 py-1"><Fact k={t('gxMaxFee')}><span className="font-semibold">{`${o.maxFeeEth} ETH`}</span></Fact></dl>
        {o.hash && <Fingerprint testid="gmx-hash">{t('gxIntentHash')} {o.hash}</Fingerprint>}
      </div>}

      {phase === 'ready' && o?.expiresAt && <Countdown expiresAt={o.expiresAt} skewMs={0} ttlMs={Math.max(1, o.expiresAt - o.createdAt)} onExpire={() => { if (phaseRef.current === 'ready') { setBad('expired'); setPhase('void'); withdraw(o.id); } }} />}
      {phase === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
      {phase === 'sending' && <Waiting>{t('gxSending')}</Waiting>}
      {bad && <Notice tone="danger"><div data-testid="gmx-integrity" data-why={bad}>{t(bad === 'expired' ? 'gxExpired' : 'gxIntegrity')}{bad !== 'expired' && <span className={`mt-1.5 ${WORDS}`}>{bad}</span>}</div></Notice>}
      {err && !(bad === 'expired') && !(phase === 'progress' && op.data?.final && op.data.state !== 'failed') && <GmxErrNotice err={err.e} raw={err.raw}>{phase === 'void' && <span className="mt-1 block">{t('gxVoidNote')}</span>}</GmxErrNotice>}

      {phase === 'progress' && <div className="space-y-3" data-testid="gmx-progress">
        {op.data ? <GmxOpCard op={op.data} timeline /> : op.isError ? <Notice tone="warn">{t('gxOpUnread')}</Notice> : <SkeletonCard lines={4} />}
        {op.data && !op.data.final && request.kind !== 'cancel' && <TwoStep expirationSec={status.facts.requestExpirationSec} />}
        <p className="text-[12.5px] leading-snug text-mute">{t('gxCloseSafe')}</p></div>}

      <div className="space-y-2.5">
        {phase === 'ready' && <Btn full className="!min-h-[56px] !text-[16px]" kind="danger" onClick={() => void approve()} data-testid="gmx-approve"><Icon n="key" className="h-[18px] w-[18px]" />{t('flApproveReal')}</Btn>}
        {phase === 'ready' && <Btn full kind="soft" onClick={close} data-testid="gmx-withdraw">{t('gxWithdraw')}</Btn>}
        {phase === 'void' && <Btn full kind="soft" onClick={() => setKey(newKey(`gmx-${request.kind}`))} data-testid="gmx-prepare-again"><Icon n="refresh" className="h-4 w-4" />{t('gxPrepareAgain')}</Btn>}
        {phase !== 'ready' && <Btn full kind="ghost" disabled={phase === 'sending' || phase === 'passkey'} onClick={close} data-testid="gmx-confirm-close">{t(phase === 'progress' ? 'fxClose' : 'cancel')}</Btn>}
        {phase === 'ready' && <p className="text-center text-[12px] leading-snug text-mute">{t('gxWithdrawNote')}</p>}
      </div>
    </div>
  </LiveSheet>;
}
