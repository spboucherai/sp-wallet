/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/screens/TradeUnified.tsx
 * Module           : screens
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

/**
 * V11 Trade — what the terminal shell adds around the existing order panels (which keep their own routes and logic):
 *   UnifiedBlotter   positions and orders of EVERY account and venue from the unified orders (/api/v1/trading), each row with
 *                    its mode — live and paper are two lists, never added — the twelve states in words, cancel and close,
 *                    attached stops and take-profits, and an order's state transitions on demand;
 *   UnifiedChecks    every check of the unified risk engine and of the mandate for the order a panel is about to confirm —
 *                    shown inside the panel's own confirmation sheet, before the passkey prompts (derivatives/orderChecks.tsx);
 *   CommandLine      the deterministic trading commands (POST /trading/commands): a dry run first, the questions when the
 *                    line does not settle everything, then the execution — the same checks as any other order.
 * Every figure comes from the server; a state the screen does not know is shown as « being verified », never as a failure.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from '../api';
import { VENUE_NAME, VenueBadge, SideTag, Pnl, Seg, timeOf } from '../derivatives/bits';
import { fmt, priceDp, usd } from '../derivatives/dec';
import type { Tone as ModeTone } from '../derivatives/live';
import { ModeTag } from '../derivatives/LiveBits';
import type { OrderChecksProps } from '../derivatives/orderChecks';
import type { Instrument, VenueId } from '../derivatives/types';
import { I18n, useT, type Key } from '../i18n';
import { LiveCell } from '../quotes-ui';
import { useQuoteSubscriptions } from '../quotes';
import { answerQuestion, attachedRole, byMode, checkCounts, checkKey, COMMAND_EXAMPLES, commandProblem, isOpen, PARSE_CODES, protectionsOf, QUESTION_FIELDS, sortChecks, stateKey, stateLook, stateOf, tapi, toUnifiedRequest, UNRESOLVABLE_CODES,
  type CanonicalOrder, type CommandAnswer, type CommandProblem, type Mode, type Question, type UnifiedOrder, type UnifiedPosition } from '../trade';
import { Btn, EmptyState, ErrorState, Fact, Fold, Icon, inputCls, Notice, SkeletonRows, Tag, Timeline, type StepState } from '../ui';

const symbolOf = (id: string | null): string => (id === null ? '—' : id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
const TYPE_KEY: Record<string, Key> = { market: 'fxKind_market', limit: 'fxKind_limit', stop_market: 'fxKind_stop', take_profit_market: 'fxKind_tp' };
/** a check's observed value or limit worth printing: a figure or a name — not the `true` / `false` of an on/off check, which its label already says */
const figure = (v: string | null): boolean => v !== null && v !== '' && v !== 'true' && v !== 'false';
const errCode = (e: unknown): string => String((e as Partial<ApiError>)?.code ?? 'error');
function Venue({ venue }: { venue: string }) { return venue in VENUE_NAME ? <VenueBadge venue={venue as VenueId} /> : <Tag>{venue}</Tag>; }
/** the unified state as icon + word */
export function StateTag({ status }: { status: string }) {
  const t = useT(); const look = stateLook(status);
  return <Tag tone={look.tone} icon={look.icon} testid="order-state"><span data-state={stateOf(status)}>{t(stateKey(status))}</span></Tag>;
}

// ---------------------------------------------------------------------------------------------------------------- unified blotter
type BlotterTab = 'positions' | 'open' | 'history';
export function UnifiedBlotter({ instruments, toneOf, onSelect }: { instruments: Map<string, Instrument>; /** which money an account moves (paper / testnet / mainnet) */ toneOf: (o: { mode: Mode; accountId: string | null; network?: string }) => ModeTone; onSelect: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [tab, setTab] = useState<BlotterTab>('positions');
  const pos = useQuery({ queryKey: ['trade', 'positions'], queryFn: tapi.positions, refetchInterval: (q) => ((q.state.data?.positions.length ?? 0) > 0 ? 5000 : 15_000), retry: 0 });
  const open = useQuery({ queryKey: ['trade', 'orders', 'open'], queryFn: () => tapi.orders({ open: true, limit: 100 }), refetchInterval: (q) => ((q.state.data?.orders.length ?? 0) > 0 ? 4000 : 15_000), retry: 0 });
  const hist = useQuery({ queryKey: ['trade', 'orders', 'final'], queryFn: () => tapi.orders({ open: false, limit: 40 }), enabled: tab === 'history', refetchInterval: 20_000, retry: 0 });
  const positions = pos.data?.positions ?? [], openOrders = (open.data?.orders ?? []).filter(isOpen);
  useQuoteSubscriptions(useMemo(() => [...new Set(positions.map((p) => p.instrument).filter((x): x is string => !!x))], [positions]));   // marks tick; only their cell re-renders
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['trade'] }); void qc.invalidateQueries({ queryKey: ['deriv'] }); };
  const q = tab === 'positions' ? pos : tab === 'open' ? open : hist;
  const groups = <T extends { mode: Mode }>(rows: readonly T[], render: (r: T) => ReactNode, empty: Key): ReactNode => {
    if (rows.length === 0) return <EmptyState icon="list" title={t(empty)} />;
    const g = byMode(rows);
    // two lists, each under its own heading: nothing is summed across them
    return <div className="space-y-4">{(['live', 'paper'] as const).filter((m) => g[m].length > 0).map((m) => <section key={m} data-testid={`ub-${m}`} aria-label={t(m === 'live' ? 'v11TrLive' : 'v11TrPaper')}>
      <h4 className="t-eyebrow mb-1.5">{t(m === 'live' ? 'v11TrLive' : 'v11TrPaper')} · {g[m].length}</h4><ul className="divide-y divide-line">{g[m].map(render)}</ul></section>)}</div>;
  };
  return <div className="space-y-3" data-testid="unified-blotter">
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2"><div className="min-w-0"><h3 className="text-[0.96875rem] font-semibold">{t('v11TrAll')}</h3><p className="text-[0.78125rem] leading-snug text-mute">{t('v11TrAllSub')}</p></div></div>
    <Seg tabs size="sm" label={t('v11TrAll')} value={tab} onChange={setTab} className="max-w-md" options={[{ id: 'positions', label: `${t('fxPositions')}${positions.length ? ` (${positions.length})` : ''}` }, { id: 'open', label: `${t('fxOpenOrders')}${openOrders.length ? ` (${openOrders.length})` : ''}` }, { id: 'history', label: t('fxOrderHistory') }]} />
    {(pos.data?.errors ?? []).length > 0 && tab === 'positions' && <Notice tone="warn">{t('v11TrSourceErrors', { sources: [...new Set(pos.data!.errors.map((e) => e.source))].join(', ') })}</Notice>}
    <div role="tabpanel" aria-label={t('v11TrAll')}>
      {q.isLoading ? <SkeletonRows n={2} /> : q.isError ? <ErrorState title={t('v11TrLoadError')} onRetry={() => void q.refetch()}>{t('v11TrErrCode', { code: errCode(q.error) })}</ErrorState>
        : tab === 'positions' ? groups(positions, (p) => <PositionRow key={p.id} p={p} orders={openOrders} instrument={p.instrument ? instruments.get(p.instrument) : undefined} tone={toneOf(p)} locale={locale} onSelect={onSelect} onDone={refresh} />, 'v11TrNoPositions')
        : tab === 'open' ? groups(openOrders, (o) => <OrderRow key={o.id} o={o} instrument={o.instrument ? instruments.get(o.instrument) : undefined} tone={toneOf(o)} locale={locale} onSelect={onSelect} onDone={refresh} />, 'v11TrNoOpen')
        : groups(hist.data?.orders ?? [], (o) => <OrderRow key={o.id} o={o} instrument={o.instrument ? instruments.get(o.instrument) : undefined} tone={toneOf(o)} locale={locale} onSelect={onSelect} onDone={refresh} />, 'v11TrNoHistory')}
    </div>
  </div>;
}
const marketBtn = (id: string | null, onSelect: (i: string) => void, label: string) => <button type="button" disabled={!id || !id.includes(':')} onClick={() => id && onSelect(id)} aria-label={label} className="-my-1 inline-flex min-h-11 items-center text-[0.9375rem] font-semibold underline decoration-line underline-offset-4 disabled:no-underline">{symbolOf(id)}</button>;

function PositionRow({ p, orders, instrument, tone, locale, onSelect, onDone }: { p: UnifiedPosition; orders: UnifiedOrder[]; instrument: Instrument | undefined; tone: ModeTone; locale: string; onSelect: (i: string) => void; onDone: () => void }) {
  const t = useT();
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle'), [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const pdp = priceDp(instrument?.tickSize, p.markPrice ?? p.entryPrice), prot = protectionsOf(p, orders);
  const close = async () => {
    setStep('busy'); setMsg(null);
    try { const r = await tapi.close(p.id); setMsg(r.order.status === 'AWAITING_APPROVAL' ? { tone: 'warn', text: t('v11TrCloseAwaiting') } : { tone: 'ok', text: t('v11TrCloseDone', { state: t(stateKey(r.order.status)) }) }); onDone(); }
    catch (e) { setMsg({ tone: 'danger', text: t('v11TrActionError', { code: errCode(e) }) }); }
    finally { setStep('idle'); }
  };
  return <li className="space-y-2 py-3" data-testid="ub-position" data-mode={p.mode} data-instrument={p.instrument ?? ''} data-account={p.accountId}>
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{marketBtn(p.instrument, onSelect, t('fxOpenMarket', { symbol: symbolOf(p.instrument) }))}<SideTag side={p.side} /><Venue venue={p.venue} /><ModeTag tone={tone} /></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-4">
      <div><dt className="text-[0.71875rem] text-mute">{t('fxSize')}</dt><dd className="font-medium tabular-nums">{fmt(p.size, { locale, trim: true })}</dd></div>
      <div><dt className="text-[0.71875rem] text-mute">{t('fxEntry')}</dt><dd className="font-medium tabular-nums">{fmt(p.entryPrice, { dp: pdp, locale })}</dd></div>
      <div><dt className="text-[0.71875rem] text-mute">{t('fxMark')}</dt><dd className="font-medium tabular-nums"><LiveCell id={p.instrument} flash={(q) => q.mark} render={(q) => (q.mark ? fmt(q.mark, { dp: pdp, locale }) : null)}>{p.markPrice ? fmt(p.markPrice, { dp: pdp, locale }) : '—'}</LiveCell></dd></div>
      <div><dt className="text-[0.71875rem] text-mute">{t('fxPnl')}</dt><dd className="font-medium"><Pnl value={p.unrealizedPnl} locale={locale} /></dd></div>
    </dl>
    <div className="flex flex-wrap items-center gap-1.5 text-[0.78125rem] text-mute" data-testid="ub-protections">{prot.length === 0 ? <span>{t('v11TrNoProtection')}</span>
      : prot.map((o) => <Tag key={o.id} tone="info" icon={attachedRole(o) === 'stop_loss' ? 'shield' : 'check'}>{t(`v11TrRole_${attachedRole(o)!}` as Key)} · {fmt(o.triggerPrice ?? o.price ?? null, { dp: pdp, locale })}</Tag>)}</div>
    {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    <div className="flex flex-wrap gap-2">{step === 'idle' ? <Btn kind="soft" className="!min-h-11 !px-4 !text-[0.875rem]" onClick={() => { setMsg(null); setStep('confirm'); }} data-testid="ub-close">{t('v11TrClose')}</Btn>
      : <><Btn kind={p.mode === 'live' ? 'danger' : 'primary'} className="!min-h-11 !px-4 !text-[0.875rem]" busy={step === 'busy'} onClick={() => void close()} data-testid="ub-close-confirm">{t(p.mode === 'live' ? 'v11TrCloseConfirmLive' : 'v11TrCloseConfirm')}</Btn>
        <Btn kind="ghost" className="!min-h-11 !px-4 !text-[0.875rem]" disabled={step === 'busy'} onClick={() => setStep('idle')}>{t('cancel')}</Btn></>}</div>
  </li>;
}

function OrderRow({ o, instrument, tone, locale, onSelect, onDone }: { o: UnifiedOrder; instrument: Instrument | undefined; tone: ModeTone; locale: string; onSelect: (i: string) => void; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null), [openHist, setOpenHist] = useState(false);
  const pdp = priceDp(instrument?.tickSize, o.price ?? o.triggerPrice ?? o.avgFillPrice ?? null), role = attachedRole(o), state = stateOf(o.status);
  const cancel = async () => { setBusy(true); setMsg(null); try { const r = await tapi.cancel(o.id); setMsg({ tone: 'ok', text: t('v11TrCancelDone', { state: t(stateKey(r.order.status)) }) }); onDone(); } catch (e) { setMsg({ tone: 'danger', text: t('v11TrActionError', { code: errCode(e) }) }); } finally { setBusy(false); } };
  return <li className="space-y-2 py-3" data-testid="ub-order" data-mode={o.mode} data-status={state} data-id={o.id} data-account={o.accountId ?? ''}>
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{marketBtn(o.instrument, onSelect, t('fxOpenMarket', { symbol: symbolOf(o.instrument) }))}{(o.side === 'buy' || o.side === 'sell') && <SideTag side={o.side} />}
      <span className="text-[0.8125rem] text-mute">{TYPE_KEY[o.type] ? t(TYPE_KEY[o.type]!) : o.type}</span><span className="ml-auto"><StateTag status={o.status} /></span></div>
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem]">
      <span className="font-medium tabular-nums">{o.size ? fmt(o.size, { locale, trim: true }) : o.notionalUsd ? usd(o.notionalUsd, locale) : '—'}{o.price ? ` @ ${fmt(o.price, { dp: pdp, locale })}` : ''}</span>
      {o.triggerPrice && <span className="text-mute">{t('v11TrTrigger', { px: fmt(o.triggerPrice, { dp: pdp, locale }) })}</span>}
      {o.filled && Number(o.filled) > 0 && <span className="text-mute">{t('v11TrFilled', { n: fmt(o.filled, { locale, trim: true }) })}{o.avgFillPrice ? ` @ ${fmt(o.avgFillPrice, { dp: pdp, locale })}` : ''}</span>}
      <Venue venue={o.venue} /><ModeTag tone={tone} />{role && <Tag tone="info" icon={role === 'stop_loss' ? 'shield' : 'check'}>{t(`v11TrRole_${role}` as Key)}</Tag>}{o.reduceOnly && !role && <Tag>{t('fxReduceOnly')}</Tag>}
    </div>
    {/* UNKNOWN is explained, in the information tone: the venue has not answered yet — the order is neither done nor failed */}
    {state === 'UNKNOWN' && <Notice tone="info"><span data-testid="ub-unknown">{t('v11TrUnknownNote')}</span></Notice>}
    {(state === 'REJECTED' || state === 'FAILED') && (o.rejectCode || o.reasonCode) && <p className="text-[0.78125rem] text-mute">{t('v11TrReason', { code: '' })}<span className="font-mono">{o.rejectCode ?? o.reasonCode}</span></p>}
    <p className="text-[0.75rem] text-mute">{timeOf(o.updatedAt, locale, true)}</p>
    {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    <div className="flex flex-wrap gap-2">
      {isOpen(o) && <Btn kind="soft" className="!min-h-11 !px-4 !text-[0.875rem]" busy={busy} onClick={() => void cancel()} data-testid="ub-cancel">{t('v11TrCancel')}</Btn>}
      <Btn kind="ghost" className="!min-h-11 !px-4 !text-[0.875rem]" aria-expanded={openHist} onClick={() => setOpenHist(!openHist)} data-testid="ub-history">{t('v11TrHistory')}</Btn>
    </div>
    {openHist && <OrderHistory id={o.id} locale={locale} />}
  </li>;
}
/** the state transitions of one order, oldest first — read when asked for */
export function OrderHistory({ id, locale }: { id: string; locale: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['trade', 'order', id], queryFn: () => tapi.order(id), staleTime: 5000, retry: 0 });
  if (q.isLoading) return <div className="skel h-16 !rounded-xl" aria-hidden="true" />;
  if (q.isError) return <Notice tone="warn">{t('v11TrErrCode', { code: errCode(q.error) })}</Notice>;
  const h = q.data?.history ?? [];
  if (h.length === 0) return <p className="text-[0.78125rem] text-mute">{t('v11TrHistoryEmpty')}</p>;
  const step = (to: string, last: boolean): StepState => (to === 'REJECTED' || to === 'FAILED' ? 'failed' : last && !['FILLED', 'CANCELLED'].includes(to) ? 'current' : 'done');
  return <div data-testid="ub-transitions"><Timeline label={t('v11TrHistory')} items={h.map((e, k) => ({ key: String(e.seq), state: step(e.to, k === h.length - 1), title: t(stateKey(e.to)),
    children: <span>{timeOf(e.at, locale, true)} · <span className="font-mono text-[0.75rem]">{e.event}</span></span> }))} /></div>;
}

// ---------------------------------------------------------------------------------------------------------------- checks before confirmation
/**
 * Every check of the unified risk engine and of the mandate for the order a panel is about to confirm. ONE request when the
 * confirmation sheet opens (a preview is recorded in the engine's journal as a preview: it is not polled). It informs; the
 * panel's own button and the server's own refusal still decide — an order this preview refuses would be refused when sent.
 */
export function UnifiedChecks({ mode, accountId, body }: OrderChecksProps) {
  const t = useT();
  const req = useMemo(() => toUnifiedRequest(mode, accountId, body), [mode, accountId, JSON.stringify(body)]);   // eslint-disable-line react-hooks/exhaustive-deps
  const q = useQuery({ queryKey: ['trade', 'preview', JSON.stringify(req)], queryFn: () => tapi.preview(req), staleTime: Infinity, gcTime: 0, retry: 0, refetchOnWindowFocus: false });
  const box = 'rounded-2xl border border-line px-4 py-3';
  if (q.isLoading) return <div className={box} data-testid="unified-checks" data-state="loading" aria-busy="true"><div className="t-eyebrow mb-2">{t('v11TrChecks')}</div><div className="skel h-12 !rounded-xl" aria-hidden="true" /></div>;
  if (q.isError || !q.data) return <div className={box} data-testid="unified-checks" data-state="unavailable"><div className="t-eyebrow mb-2">{t('v11TrChecks')}</div><p className="text-[0.8125rem] leading-snug text-mute">{t('v11TrChecksUnavailable', { code: errCode(q.error) })}</p></div>;
  const p = q.data, n = checkCounts(p.risk.checks), checks = sortChecks(p.risk.checks);
  return <div className={box} data-testid="unified-checks" data-state="ready" data-decision={p.risk.decision} data-would-execute={String(p.wouldExecute)}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="t-eyebrow">{t('v11TrChecks')}</span>
      {n.failed > 0 ? <Tag tone="danger" icon="x">{t('v11TrChecksFailed', { n: n.failed })}</Tag> : <Tag tone="ok" icon="check">{t('v11TrChecksPassed', { n: n.passed })}</Tag>}</div>
    <dl className="mt-1">
      <Fact k={t('v11TrRiskEngine')} testid="uc-risk">{t(p.risk.decision === 'allow' ? 'v11TrAllowed' : 'v11TrDenied')}{p.risk.reducing ? ` · ${t('v11TrReducing')}` : ''}</Fact>
      <Fact k={t('v11TrMandate')} testid="uc-mandate">{p.mandate === null ? t('v11TrMandateOwner') : p.mandate.decision === 'allow' ? t('v11TrAllowed') : <>{t('v11TrDenied')} <span className="font-mono text-[0.75rem]">{p.mandate.reasons.join(', ')}</span></>}</Fact>
      <Fact k={t('v11TrApproval')} testid="uc-approval">{t(`v11TrApproval_${p.approval.by}` as Key)}</Fact>
    </dl>
    {p.refusals.map((r) => <div key={`${r.stage}${r.code}`} className="mt-2"><Notice tone="danger"><span data-testid="uc-refusal" data-code={r.code}>{t('v11TrRefusal', { stage: t(`v11TrStage_${r.stage}` as Key) })} <span className="font-mono text-[0.75rem]">{r.code}</span></span></Notice></div>)}
    <Fold open={n.failed > 0} testid="uc-list" summary={<span className="text-[0.84375rem] font-medium text-ink">{t('v11TrChecksAll', { n: checks.length })}{n.exempt > 0 ? ` · ${t('v11TrChecksExempt', { n: n.exempt })}` : ''}</span>}>
      <ul className="space-y-1.5">{checks.map((c) => { const k = checkKey(c.id), bad = !c.ok && !c.exempt; return (
        <li key={c.id} className="flex items-start gap-2 text-[0.8125rem] leading-snug" data-testid="uc-check" data-id={c.id} data-ok={String(c.ok)} data-exempt={String(c.exempt)}>
          <Icon n={bad ? 'x' : c.exempt ? 'minus' : 'check'} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${bad ? 'text-danger' : c.exempt ? 'text-mute' : 'text-emerald'}`} />
          <span className="min-w-0"><span className={bad ? 'font-semibold' : ''}>{k ? t(k) : <span className="font-mono text-[0.75rem]">{c.id}</span>}</span>
            <span className="text-mute"> — {t(bad ? 'v11TrCheckFail' : c.exempt ? 'v11TrCheckExempt' : 'v11TrCheckOk')}{figure(c.observed) ? ` · ${t('v11TrObserved', { v: c.observed! })}` : ''}{figure(c.limit) ? ` · ${t('v11TrLimit', { v: c.limit! })}` : ''}</span>
            {bad && c.detail && <span className="mt-0.5 block text-[0.75rem] text-mute" lang="en"><span lang="">{t('v11TrDetailEn')} : </span>{c.detail}</span>}</span></li>); })}</ul>
    </Fold>
  </div>;
}

// ---------------------------------------------------------------------------------------------------------------- command line
type CmdState = { phase: 'idle' } | { phase: 'busy'; run: boolean } | { phase: 'preview'; text: string; answer: CommandAnswer } | { phase: 'done'; answer: CommandAnswer } | { phase: 'problem'; problem: CommandProblem };
const idem = (): string => `ui-cmd-${crypto.randomUUID()}`;
export function CommandLine({ mode, accountId, tone, onDone, onSelect }: { mode: Mode; accountId: string | null; tone: ModeTone; onDone: () => void; onSelect: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [text, setText] = useState(''), [st, setSt] = useState<CmdState>({ phase: 'idle' }), [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null), runKey = useRef('');
  const defaults = useQuery({ queryKey: ['trade', 'cmd-defaults'], queryFn: tapi.defaults, staleTime: 60_000, retry: 0 });
  const send = async (line: string, run: boolean) => {
    const cmd = line.trim().replace(/\s+/g, ' ');
    if (!cmd) return;
    if (!run) runKey.current = idem();                    // one key per previewed line: confirming twice places one order
    setSt({ phase: 'busy', run });
    try {
      const answer = await tapi.command(cmd, mode, accountId, !run, run ? runKey.current : idem());
      if (run || answer.kind === 'query') { setSt({ phase: 'done', answer }); if (run) { onDone(); void qc.invalidateQueries({ queryKey: ['risk'] }); } }
      else setSt({ phase: 'preview', text: cmd, answer });
    } catch (e) { setSt({ phase: 'problem', problem: commandProblem(e) }); }
  };
  const answer = async (q: Question, value: string) => {
    const r = answerQuestion(text, defaults.data ?? {}, q.field, value);
    if (!r) { setNote(t('v11TrQInvalid')); return; }
    if ('text' in r) { setText(r.text); setNote(t('v11TrQIntoLine')); await send(r.text, false); return; }
    try { qc.setQueryData(['trade', 'cmd-defaults'], await tapi.setDefaults(r.defaults)); setNote(t('v11TrQSaved')); await send(text, false); }
    catch (e) { setNote(t('v11TrActionError', { code: errCode(e) })); }
  };
  const busy = st.phase === 'busy';
  const stale = st.phase === 'preview' && st.text !== text.trim().replace(/\s+/g, ' ');   // the line changed since its preview: preview again before anything runs
  return <section className="space-y-3" data-testid="cmdline" aria-label={t('v11TrCmd')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[0.96875rem] font-semibold">{t('v11TrCmd')}</h3><ModeTag tone={tone} /></div>
    <p className="text-[0.78125rem] leading-snug text-mute">{t('v11TrCmdSub')}</p>
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setNote(''); void send(text, false); }}>
      <input ref={input} value={text} onChange={(e) => { setText(e.target.value.slice(0, 300)); }} aria-label={t('v11TrCmdLabel')} placeholder={COMMAND_EXAMPLES[0]} data-testid="cmd-input" enterKeyHint="go" autoCapitalize="characters" autoCorrect="off" autoComplete="off" spellCheck={false}
        className={`${inputCls} min-w-0 flex-1 !py-3 font-mono text-[1rem]`} />
      <Btn type="submit" kind="soft" busy={busy && !st.run} disabled={busy || !text.trim()} className="!min-h-[50px] shrink-0 !px-4" data-testid="cmd-preview">{t('v11TrCmdPreview')}</Btn>
    </form>
    <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1" role="group" aria-label={t('v11TrCmdExamples')}>{COMMAND_EXAMPLES.map((x) => <button key={x} type="button" onClick={() => { setText(x); setSt({ phase: 'idle' }); input.current?.focus(); }} className="press min-h-11 shrink-0 rounded-full border border-line px-3 font-mono text-[0.78125rem] text-mute">{x}</button>)}</div>
    <div aria-live="polite" className="space-y-3" data-testid="cmd-result" data-phase={st.phase}>
      {note && <p className="text-[0.78125rem] text-mute" data-testid="cmd-note">{note}</p>}
      {st.phase === 'problem' && <Problem p={st.problem} onAnswer={(q, v) => void answer(q, v)} />}
      {st.phase === 'preview' && <div className="space-y-3 rounded-2xl border border-line px-4 py-3" data-testid="cmd-dry" data-kind={st.answer.kind}>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="t-eyebrow">{t('v11TrCmdDry')}</span><ModeTag tone={tone} /></div>
        {st.answer.kind === 'order' && !st.answer.executed && <><Canonical c={st.answer.order} locale={locale} /><AttachedList a={st.answer.attached} /></>}
        {st.answer.kind === 'control' && <p className="text-[0.84375rem] leading-snug" data-testid="cmd-control">{t(`v11TrCtl_${st.answer.control.type}` as Key, { n: st.answer.orders?.length ?? 0 })}</p>}
        {stale ? <Notice tone="warn">{t('v11TrCmdStale')}</Notice>
          : <div className="flex flex-wrap gap-2"><Btn kind={st.answer.kind === 'control' && st.answer.control.type !== 'cancel_order' && st.answer.control.type !== 'cancel_all' ? 'danger' : mode === 'live' && st.answer.kind === 'order' ? 'danger' : 'primary'} className="!min-h-11 !px-4 !text-[0.90625rem]" onClick={() => void send(st.text, true)} data-testid="cmd-run">
              {t(st.answer.kind === 'control' ? 'v11TrCmdRunControl' : mode === 'live' ? 'v11TrCmdRunLive' : 'v11TrCmdRunPaper')}</Btn>
            <Btn kind="ghost" className="!min-h-11 !px-4 !text-[0.90625rem]" onClick={() => setSt({ phase: 'idle' })}>{t('v11TrCmdClear')}</Btn></div>}
      </div>}
      {st.phase === 'busy' && st.run && <div className="skel h-14 !rounded-2xl" aria-hidden="true" />}
      {st.phase === 'done' && <Done a={st.answer} locale={locale} onSelect={onSelect} />}
    </div>
  </section>;
}
function Canonical({ c, locale }: { c: CanonicalOrder; locale: string }) {
  const t = useT();
  return <dl className="receipt" data-testid="cmd-canonical" data-instrument={c.instrument} data-side={c.side}>
    <Fact k={t('fxMarket')}>{symbolOf(c.instrument)} · {VENUE_NAME[c.venue as VenueId] ?? c.venue}</Fact>
    <Fact k={t('fxDirection')}><SideTag side={c.side} />{c.reduceOnly ? ` · ${t('fxReduceOnly')}` : ''}</Fact>
    <Fact k={t('fxOrderType')}>{TYPE_KEY[c.type] ? t(TYPE_KEY[c.type]!) : c.type}{c.limitPrice ? ` @ ${fmt(c.limitPrice, { locale, trim: true })}` : ''}</Fact>
    {c.size !== null && <Fact k={t('fxSize')}>{fmt(c.size, { locale, trim: true })}</Fact>}
    {c.notional !== null && <Fact k={t('v11TrNotional')}>{usd(c.notional, locale)}</Fact>}
    {c.leverage !== null && <Fact k={t('v11TrLev')}>{fmt(c.leverage, { locale, trim: true })}×</Fact>}
    <Fact k={t('v11TrMaxSlip')}>{fmt(String(c.maxSlippageBps / 100), { locale, trim: true })} %</Fact>
    <Fact k={t('v11TrMaxFee')}>{usd(c.maxFeeUsd, locale)}</Fact>
  </dl>;
}
function AttachedList({ a }: { a: { role: 'stop_loss' | 'take_profit'; placed: boolean }[] }) {
  const t = useT();
  if (a.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5" data-testid="cmd-attached">{a.map((x, k) => <Tag key={k} tone={x.placed ? 'ok' : 'info'} icon={x.role === 'stop_loss' ? 'shield' : 'check'}>{t(`v11TrRole_${x.role}` as Key)} · {t(x.placed ? 'v11TrAttachedPlaced' : 'v11TrAttachedPending')}</Tag>)}</div>;
}
function Done({ a, locale, onSelect }: { a: CommandAnswer; locale: string; onSelect: (i: string) => void }) {
  const t = useT();
  if (a.kind === 'query') { const rows = Object.values(a.data).find(Array.isArray) as unknown[] | undefined;
    return <div className="rounded-2xl border border-line px-4 py-3" data-testid="cmd-query" data-query={a.query}><div className="flex flex-wrap items-center justify-between gap-2"><span className="t-eyebrow">{a.command}</span>{rows && <Tag>{t('v11TrQueryRows', { n: rows.length })}</Tag>}</div>
      <Fold summary={<span className="text-[0.84375rem] font-medium text-ink">{t('v11TrQueryRaw')}</span>} open={!rows || rows.length <= 3}><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-elev p-3 font-mono text-[0.71875rem] leading-snug">{JSON.stringify(a.data, null, 1).slice(0, 6000)}</pre></Fold></div>; }
  if (a.kind === 'control') return <Notice tone="ok"><span data-testid="cmd-done" data-kind="control">{t('v11TrCtlDone')}{a.results ? ` ${t('v11TrQueryRows', { n: a.results.length })}` : ''}</span></Notice>;
  if (!a.executed) return null;
  const o = a.order, awaiting = o.status === 'AWAITING_APPROVAL';
  return <div className="space-y-2 rounded-2xl border border-line px-4 py-3" data-testid="cmd-done" data-kind="order" data-status={stateOf(o.status)} data-id={o.id}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="t-eyebrow">{t('v11TrCmdExecuted')}</span><StateTag status={o.status} /></div>
    <div className="flex flex-wrap items-center gap-2 text-[0.84375rem]">{marketBtn(o.instrument, onSelect, t('fxOpenMarket', { symbol: symbolOf(o.instrument) }))}{(o.side === 'buy' || o.side === 'sell') && <SideTag side={o.side} />}<span className="tabular-nums">{o.size ? fmt(o.size, { locale, trim: true }) : ''}{o.avgFillPrice ? ` @ ${fmt(o.avgFillPrice, { locale, trim: true })}` : ''}</span></div>
    <AttachedList a={a.attached} />
    {awaiting && <Notice tone="warn">{t('v11TrCloseAwaiting')}</Notice>}
    {stateOf(o.status) === 'UNKNOWN' && <Notice tone="info">{t('v11TrUnknownNote')}</Notice>}
  </div>;
}
function Problem({ p, onAnswer }: { p: CommandProblem; onAnswer: (q: Question, value: string) => void }) {
  const t = useT();
  if (p.kind === 'parse') return <Notice tone="warn"><span data-testid="cmd-problem" data-kind="parse" data-code={p.code}>{t(((PARSE_CODES as readonly string[]).includes(p.code) ? `v11TrParse_${p.code}` : 'v11TrParse_unknown_command') as Key)}{p.token !== null ? ` ${t('v11TrParseAt', { n: p.token + 1 })}` : ''}</span></Notice>;
  if (p.kind === 'unresolvable') return <Notice tone="warn"><span data-testid="cmd-problem" data-kind="unresolvable" data-code={p.code}>{t(((UNRESOLVABLE_CODES as readonly string[]).includes(p.code) ? `v11TrUnres_${p.code}` : 'v11TrUnres_invalid_order') as Key)}</span></Notice>;
  if (p.kind === 'refused') return <Notice tone="danger"><span data-testid="cmd-problem" data-kind="refused" data-code={p.code}>{t('v11TrCmdRefused')} <span className="font-mono text-[0.75rem]">{[p.code, ...p.failed, ...p.reasons].join(', ')}</span></span></Notice>;
  if (p.kind === 'error') return <Notice tone="warn"><span data-testid="cmd-problem" data-kind="error" data-code={p.code}>{t('v11TrErrCode', { code: p.code })}</span></Notice>;
  return <div className="space-y-3 rounded-2xl border border-warn/30 bg-warn/[0.06] px-4 py-3" data-testid="cmd-questions">
    <p className="text-[0.84375rem] font-medium leading-snug">{t('v11TrCmdQuestions')}</p>
    {p.questions.map((q) => <QuestionRow key={q.field} q={q} onAnswer={(v) => onAnswer(q, v)} />)}
  </div>;
}
function QuestionRow({ q, onAnswer }: { q: Question; onAnswer: (value: string) => void }) {
  const t = useT(); const [v, setV] = useState('');
  const known = (QUESTION_FIELDS as readonly string[]).includes(q.field), intoLine = q.field === 'venue' || q.field === 'instrument' || q.field === 'leverage';
  const label = known ? t(`v11TrQ_${q.field}` as Key) : t('v11TrQ_other', { field: q.field });
  return <div className="space-y-1.5" data-testid="cmd-question" data-field={q.field}>
    <p className="text-[0.84375rem] leading-snug">{label}</p>
    {q.options.length > 0 ? <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>{q.options.map((o) => <button key={o} type="button" onClick={() => onAnswer(o)} data-option={o} className="press min-h-11 rounded-full border border-line bg-surface px-3.5 text-[0.84375rem] font-medium">{q.field === 'marginMode' ? t(`v11TrOpt_${o}` as Key) : q.field === 'venue' ? VENUE_NAME[o as VenueId] ?? o : o}</button>)}</div>
      : <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onAnswer(v); }}><input value={v} onChange={(e) => setV(e.target.value.slice(0, 20))} inputMode="decimal" aria-label={label} className={`${inputCls} min-w-0 flex-1 !py-2.5 text-[1rem]`} /><Btn type="submit" kind="soft" className="!min-h-11 shrink-0 !px-4 !text-[0.875rem]" disabled={!v.trim()}>{t('v11TrQUse')}</Btn></form>}
    {!intoLine && <p className="text-[0.75rem] text-mute">{t('v11TrQDefaultHint')}</p>}
  </div>;
}
