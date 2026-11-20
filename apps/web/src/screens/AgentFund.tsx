// Funding an agent's wallet from the main wallet, bringing funds back, and the readiness checklist of the agent page.
// Nothing here is a new money path: funding is the ordinary transfer flow (draft → frozen intent → passkey → signer),
// with the network and the recipient fixed to the agent's own; withdrawing is the existing vault-return route.
import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { get, post } from '../api';
import { answerLost, cancelDraft, DraftKey, proposalApplied } from '../approval';
import { ApprovalOutcomePanel, useApprovalOutcome } from '../approvalUi';
import type { Nav } from '../App';
import { useAccounts, useNetworks, usePortfolio, type Net, type Proposal } from '../hooks';
import { errText, I18n, useT, type Key } from '../i18n';
import { srvText } from '../srvText';
import { svText } from '../sv'; // v11: server texts by code
import { Addr, Btn, Coin, CopyBtn, Fact, Icon, NetDot, Notice, ProgressRing, Sheet, Tag, trimAmt, usdCapital, type Tone } from '../ui';
import { amountInputText, amountLocale, amountOf, sanitizeAmountText } from '../amount'; // v8 hardening: one rule for typed amounts
import { AmountProblem } from '../amountUi';
import { useTrackedWithdrawals, WD_OPEN, withdrawalNotice, type Wd } from './withdrawTrack'; // v8 hardening: a withdrawal shows its real state

type T = (k: Key, v?: Record<string, string | number>) => string;
export interface VaultRow { symbol: string; assetSymbol: string; name: string; kind: string; issuer: string | null; role: 'cash' | 'asset' | 'gas'; asset: string; amount: string; display: string; usd: number | null }
export interface FundAgent { id: string; name: string; state: string; network: string; networkName: string; cash: string; capitalUsdc: string; vaultAddress: string; strategyVersionId: string | null;
  holdings: { symbol: string; asset: string; assetSymbol: string; name: string; kind: string }[] | null; vault: VaultRow[] | null }
interface GasInfo { reserve: string; perOrder: string; perOrderUsd: number | null }
export interface AgentNet { id: string; name: string; native: string; gas: GasInfo | null; feeWarning: boolean; symbols: { symbol: string; live: boolean }[] }
interface Overview { broadcast?: boolean; signer: { reachable: boolean; halted?: boolean; policy?: { perTx: Record<string, string>; daily: Record<string, string> }; spentToday?: Record<string, string> } }
interface Elsewhere { network: string; networkName: string; asset: string; symbol: string; display: string; gas: string; hasGas: boolean; gasHeld?: string; gasNeed?: string | null; gasEnough?: boolean | null }

// ── exact decimal arithmetic on display strings (amounts never go through floating point) ─────────────────────────────────
export const toUnits = (s: string, dec: number): bigint => { const m = /^(\d*)(?:\.(\d*))?$/.exec(s.trim()); if (!m || (!m[1] && !m[2])) return 0n; return BigInt((m[1] || '0') + (m[2] ?? '').slice(0, dec).padEnd(dec, '0')); };
export const fromUnits = (v: bigint, dec: number): string => { const neg = v < 0n, s = (neg ? -v : v).toString().padStart(dec + 1, '0'); const i = s.slice(0, s.length - dec), f = dec ? s.slice(s.length - dec).replace(/0+$/, '') : ''; return (neg ? '-' : '') + (f ? `${i}.${f}` : i); };
const minBig = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
/** Round a base-unit amount UP to `keep` significant decimals (a gas top-up must not fall one wei short). */
const ceilTo = (v: bigint, dec: number, keep: number): bigint => { if (dec <= keep) return v; const q = 10n ** BigInt(dec - keep); return ((v + q - 1n) / q) * q; };
const sameAsset = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** v11 (B2): a transfer signed on a server that does not broadcast is in the terminal state `not_broadcast` — the state says it, not the wording of a sentence */
const NOT_SENT = 'not_broadcast';
const OK = ['confirming', 'finalized'], BAD = ['failed', 'rejected', 'expired', 'replaced'];

/** Plain words for a refusal of the transfer flow; the server's English detail is only used when no code is known. */
export function fundErr(t: T, e: unknown, ctx: { sym: string; net: string; native: string; perTx?: string; left?: string }): string {
  const x = e as { code?: string; message?: string; name?: string };
  if (x?.name === 'NotAllowedError' || x?.name === 'AbortError') return t('qaFundPasskeyCancelled');
  const m = x?.message ?? '';
  switch (x?.code) {
    case 'policy': return /per-transaction/.test(m) ? t('qaFundErrPerTx', { max: ctx.perTx ?? '?', sym: ctx.sym }) : /daily limit/.test(m) ? t('qaFundErrDaily', { left: ctx.left ?? '0', sym: ctx.sym }) : /fee ceiling/.test(m) ? t('qaFundErrFee', { net: ctx.net }) : /halt/.test(m) ? t('e_halted') : `${t('e_policy')} (${t('v11LoSrvDetail', { detail: m })})`;
    case 'insufficient_funds': return t('qaFundErrBalance', { sym: ctx.sym, net: ctx.net });
    case 'insufficient_gas': return t('qaFundErrGas', { native: ctx.native, net: ctx.net });
    case 'pending_tx': return t('qaFundErrPending', { net: ctx.net });
    case 'halted': return t('e_halted');
    case 'expired': return t('qaFundErrExpired');
    case 'offline': return t('offline');
    default: return errText(t, e);
  }
}

/**
 * One ordinary transfer of the main wallet, up to the passkey: draft, frozen intent, passkey over its hash. The approval itself
 * is NOT sent here (NEXT W1): the caller submits it through approval.ts, where a lost answer is settled by the server's state.
 * `assertion` is absent when the transfer is already past the passkey (resumed).
 */
async function draftTransfer(o: { network: string; asset: string; to: string; amount: string; note: string; idem: string; onDraft?: (id: string) => void }): Promise<{ proposal: Proposal; assertion?: unknown }> {
  const p = await post<Proposal>('/transfers/proposals', { network: o.network, asset: o.asset, to: o.to, amount: o.amount, note: o.note.slice(0, 80) }, { 'idempotency-key': o.idem });
  o.onDraft?.(p.id);
  if (proposalApplied(p)) return { proposal: p };                                     // resumed: already past the passkey
  const ra = await post<{ proposal: Proposal; options: never }>(`/transfers/proposals/${p.id}/request-approval`);
  return { proposal: ra.proposal, assertion: await startAuthentication({ optionsJSON: ra.options }) };   // challenge = fingerprint of this exact transfer
}

/** The one network of this operation, fixed: the network's logo, the sentence, a lock. */
const NetBanner = ({ net, children }: { net: string; children: ReactNode }) => <div className="flex items-center gap-3 rounded-2xl bg-elev/70 px-3.5 py-3"><NetDot net={net} size={30} /><span className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{children}</span><Icon n="lock" className="h-4 w-4 shrink-0 text-mute" /></div>;
/** A typed amount as the sheet's main figure: the asset's logo, a large field, the symbol; `right` is the field's own shortcut (Max). */
function AmountBox({ id, sym, net, value, onChange, right }: { id: string; sym: string; net: string; value: string; onChange: (v: string) => void; right?: ReactNode }) {
  return <div className="flex items-center gap-3 rounded-2xl border border-line bg-elev/60 py-2 pl-3.5 pr-2.5 transition focus-within:border-blue focus-within:bg-surface focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--blue)_16%,transparent)]">
    <Coin sym={sym} net={net} size={36} />
    <input id={id} className="t-num min-w-0 flex-1 bg-transparent py-1.5 text-[26px] outline-none placeholder:text-mute/70" inputMode="decimal" placeholder="0" value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    <span className="shrink-0 text-[14px] font-semibold text-mute">{sym}</span>{right}</div>;
}

// ── funding ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Leg { key: 'cash' | 'gas'; asset: string; symbol: string; amount: string; idem: string; proposalId?: string; state?: string; error?: string; txError?: string | null; txCode?: string | null; txParams?: Record<string, string | number> | null; explorer?: string | null }
const store = (id: string) => `spw-fund-${id}`;
const loadLegs = (id: string): Leg[] | null => { try { const j = JSON.parse(localStorage.getItem(store(id)) ?? 'null') as { at: number; legs: Leg[] } | null; return j && Date.now() - j.at < 86_400_000 && Array.isArray(j.legs) ? j.legs : null; } catch { return null; } };
const legDone = (l: Leg) => OK.includes(l.state ?? '');
const legTest = (l: Leg) => l.state === NOT_SENT;
/** True when a funding run of this agent was started and is not finished (the agent page offers to resume it). */
export const fundingInProgress = (id: string): boolean => { const l = loadLegs(id); return !!l && l.some((x) => !!x.proposalId || !!x.error) && !l.every(legDone); };

export function FundSheet({ a, gas, nav, onClose }: { a: FundAgent; gas: GasInfo | null; nav: Nav; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const pf = usePortfolio(), nets = useNetworks(), acc = useAccounts();
  const ov = useQuery({ queryKey: ['security'], queryFn: () => get<Overview>('/security/overview'), staleTime: 15_000 });
  const br = useQuery({ queryKey: ['bridge-exec'], queryFn: () => get<{ networks: string[] }>('/bridge/execution'), staleTime: 600_000 });
  const n: Net | undefined = nets.data?.find((x) => x.id === a.network);
  const cashId = a.holdings?.[0]?.asset ?? a.vault?.find((x) => x.role === 'cash')?.asset ?? '';
  const cashDef = n?.tokens.find((x) => sameAsset(x.id, cashId)), native = n?.native;
  const cashDec = cashDef?.decimals ?? 6, natDec = native?.decimals ?? 18, natSym = native?.symbol ?? '';
  const cashName = a.holdings?.[0]?.name ?? a.cash;
  const main = (asset: string) => pf.data?.balances.find((b) => b.network === a.network && sameAsset(b.asset, asset));
  const mainCash = BigInt(main(cashId)?.amount ?? '0'), mainNat = BigInt(main('native')?.amount ?? '0');
  const vaultOf = (asset: string) => BigInt(a.vault?.find((x) => sameAsset(x.asset, asset))?.amount ?? '0');
  const vCash = vaultOf(cashId), vNat = vaultOf('native');
  const reserve = gas ? toUnits(gas.reserve, natDec) : null;
  const missing = reserve !== null && reserve > vNat ? ceilTo(reserve - vNat, natDec, 6) : 0n;
  const pol = ov.data?.signer.policy, spent = ov.data?.signer.spentToday ?? {};
  const cap = (sym: string, dec: number) => { const k = `${a.network}:${sym}`; if (!pol || pol.perTx[k] === undefined) return null; const per = BigInt(pol.perTx[k]), day = BigInt(pol.daily[k] ?? '0'), used = BigInt(spent[k] ?? '0'); const left = day > used ? day - used : 0n; return { per, left, perD: fromUnits(per, dec), leftD: fromUnits(left, dec), dayD: fromUnits(day, dec) }; };
  const capCash = cap(a.cash, cashDec), capNat = cap(natSym, natDec);
  const maxCash = minBig(mainCash, ...(capCash ? [capCash.per, capCash.left] : []));
  const planned = toUnits(a.capitalUsdc, cashDec);

  const [legs, setLegsRaw] = useState<Leg[] | null>(() => loadLegs(a.id)); const ap = useApprovalOutcome<Proposal>();
  const setLegs = (l: Leg[] | null) => { setLegsRaw(l); if (l) localStorage.setItem(store(a.id), JSON.stringify({ at: Date.now(), legs: l })); else localStorage.removeItem(store(a.id)); };
  const [cashAmt, setCashAmt] = useState(''), [gasAmt, setGasAmt] = useState(''), [busy, setBusy] = useState(false), [touched, setTouched] = useState(false);
  const loc = amountLocale();
  // suggested amounts, once the balances are known: what is missing to reach the planned capital / the gas reserve
  useEffect(() => { if (touched || legs || !pf.data || !n) return;
    const want = planned > vCash ? planned - vCash : 0n, c = minBig(want, maxCash);
    setCashAmt(c > 0n ? amountInputText(fromUnits(c, cashDec), loc) : ''); setGasAmt(missing > 0n ? amountInputText(fromUnits(missing, natDec), loc) : '');
  }, [pf.data, n, ov.data, a.vault, touched, legs]); // eslint-disable-line react-hooks/exhaustive-deps
  // v8 hardening: the fields keep what was typed; an unreadable text (invalid, ambiguous) counts for nothing and is said under the field
  const cashU = toUnits(amountOf(cashAmt, loc) ?? '', cashDec), gasU = toUnits(amountOf(gasAmt, loc) ?? '', natDec);
  const cashTooMuch = cashU > mainCash, cashOverPer = !!capCash && cashU > capCash.per, cashOverDay = !!capCash && cashU > capCash.left;
  const gasTooMuch = gasU > 0n && gasU >= mainNat, gasOverPer = !!capNat && gasU > capNat.per;
  const usdcElsewhere = a.cash === 'USDC' ? (pf.data?.balances ?? []).filter((b) => b.symbol === 'USDC' && b.network !== a.network && b.amount !== null && b.amount !== '0') : [];
  const canBridge = (from: string) => !!br.data?.networks.includes(from) && br.data.networks.includes(a.network);
  const myAddr = acc.data?.accounts.find((x) => x.network === a.network)?.address;

  // progress of the transfer in flight (and of a resumed one)
  const cur = legs?.find((l) => l.proposalId && !legDone(l) && !BAD.includes(l.state ?? ''));
  const live = useQuery({ queryKey: ['proposal', cur?.proposalId], enabled: !!cur?.proposalId, refetchInterval: 3000, queryFn: () => get<Proposal>(`/transfers/proposals/${cur!.proposalId}`) });
  useEffect(() => { const p = live.data; if (!p || !legs || !cur || p.id !== cur.proposalId) return;
    if (p.state === cur.state && (p.error ?? null) === (cur.txError ?? null)) return;
    setLegs(legs.map((l) => (l.proposalId === p.id ? { ...l, state: p.state, txError: p.error, txCode: p.errorCode, txParams: p.errorParams, explorer: p.explorer } : l)));
    if (OK.includes(p.state)) { void qc.invalidateQueries({ queryKey: ['agent', a.id] }); void qc.invalidateQueries({ queryKey: ['portfolio'] }); }
  }, [live.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctxOf = (l: Leg) => ({ sym: l.symbol, net: a.networkName, native: natSym, perTx: (l.key === 'cash' ? capCash : capNat)?.perD, left: (l.key === 'cash' ? capCash : capNat)?.leftD });
  const run = async (all: Leg[], k: number) => {
    const l = all[k]!; let next = all.map((x, i) => (i === k ? { ...x, error: undefined } : x)); setLegs(next); setBusy(true);
    const patch = (p: Partial<Leg>) => { next = next.map((x, i) => (i === k ? { ...x, ...p } : x)); setLegs(next); };
    const took = (p: Proposal) => { patch({ proposalId: p.id, state: p.state, txError: p.error, txCode: p.errorCode, txParams: p.errorParams, explorer: p.explorer }); void qc.invalidateQueries({ queryKey: ['security'] }); };
    // An ANSWERED refusal: nothing was approved by this request. The draft left behind is cancelled so that a retry starts clean
    // (a new idempotency key); a cancellation that fails is said with the error, never swallowed.
    const refused = async (e: unknown) => {
      const id = next[k]!.proposalId; let more = '';
      if (id) { const c = await cancelDraft(() => post(`/transfers/proposals/${id}/reject`)); if (c.kind === 'failed') more = ` ${t('nxCancelFailed', { why: errText(t, c.error) })}`; }
      patch({ error: fundErr(t, e, ctxOf(l)) + more, proposalId: undefined, state: undefined, idem: crypto.randomUUID() });
    };
    let d: { proposal: Proposal; assertion?: unknown };
    try { d = await draftTransfer({ network: a.network, asset: l.asset, to: a.vaultAddress, amount: l.amount, note: `Agent ${a.name}`, idem: l.idem, onDraft: (id) => patch({ proposalId: id, state: 'draft' }) }); }
    catch (e) {
      // before the approval: a lost answer (or a passkey prompt that was closed) keeps the SAME key — the retry finds the same draft
      if (answerLost(e)) patch({ error: fundErr(t, e, ctxOf(l)), proposalId: undefined, state: undefined }); else await refused(e);
      setBusy(false); return;
    }
    if (d.assertion === undefined) { took(d.proposal); setBusy(false); return; }
    // the approval leaves the browser: only a state read from the server says what happened. While it is unknown the leg keeps its
    // proposal (no button, no new key) and the proposal is polled; nothing is cancelled and nothing is sent again.
    const pid = d.proposal.id; patch({ proposalId: pid, state: d.proposal.state });
    await ap.run({ submit: () => post<Proposal>(`/transfers/proposals/${pid}/approve`, { assertion: d.assertion }), read: () => get<Proposal>(`/transfers/proposals/${pid}`), applied: proposalApplied }, (o) => {
      if (o.kind === 'refused') { void refused(o.error); return; }
      if (o.kind === 'read' && !o.applied) { patch({ error: undefined, proposalId: undefined, state: undefined }); return; }   // same key: the retry resumes this very proposal
      took(o.kind === 'answered' ? o.value : o.state);
    });
    setBusy(false);
  };
  const start = () => { const l: Leg[] = [];
    if (cashU > 0n) l.push({ key: 'cash', asset: cashId, symbol: a.cash, amount: fromUnits(cashU, cashDec), idem: crypto.randomUUID() });
    if (gasU > 0n) l.push({ key: 'gas', asset: 'native', symbol: natSym, amount: fromUnits(gasU, natDec), idem: crypto.randomUUID() });
    if (l.length) void run(l, 0); };
  const finish = () => { setLegs(null); void qc.invalidateQueries({ queryKey: ['agent', a.id] }); void qc.invalidateQueries({ queryKey: ['portfolio'] }); onClose(); };
  const row = (k: string, v: ReactNode) => <Fact k={k}>{v}</Fact>;
  const toSwap = (from: string) => { sessionStorage.setItem('spw-swap-prefill', JSON.stringify({ fromNetwork: from, toNetwork: a.network, symbol: 'USDC' })); nav({ tab: 'swap' }); };

  const title = t('qaFundTitle', { name: a.name });
  if (legs) { // ── progress: one transfer after the other, each with its own passkey prompt
    const nextK = legs.findIndex((l) => !legDone(l)), allDone = nextK < 0, stuck = legs.some(legTest);
    const stepBtn = !allDone && !stuck ? (() => { const l = legs[nextK]!, waiting = !!l.proposalId && !BAD.includes(l.state ?? '');
      if (waiting) return null;
      const retry = !!l.error || BAD.includes(l.state ?? '');
      return <Btn full busy={busy} onClick={() => void run(retry && BAD.includes(l.state ?? '') ? legs.map((x, i) => (i === nextK ? { ...x, proposalId: undefined, state: undefined, txError: undefined, idem: crypto.randomUUID() } : x)) : legs, nextK)}><Icon n="key" />{retry ? t('qaFundRetry', { k: nextK + 1, n: legs.length, amount: trimAmt(l.amount, 8), sym: l.symbol }) : t('qaFundStep', { k: nextK + 1, n: legs.length, amount: trimAmt(l.amount, 8), sym: l.symbol })}</Btn>; })() : null;
    return <Sheet title={title} onClose={onClose} busy={busy}
      footer={allDone || stuck ? <Btn full kind={allDone ? 'primary' : 'soft'} onClick={finish}>{t('qaFundFinish')}</Btn> : stepBtn ?? undefined}>
      <NetBanner net={a.network}>{t('qaFundOnly', { net: a.networkName })}</NetBanner>
      <ol className="mt-4 space-y-2.5" aria-label={t('qaFundProgress')}>{legs.map((l, k) => { const done = legDone(l), test = legTest(l), bad = BAD.includes(l.state ?? ''), waiting = !!l.proposalId && !done && !bad && !test, isNext = k === nextK;
        const tone: Tone = done ? 'ok' : test ? 'warn' : bad || l.error ? 'danger' : waiting ? 'info' : 'mute';
        return <li key={l.key} className={`rounded-2xl border p-3.5 ${isNext && !done ? 'border-primary/35 bg-elev/40' : 'border-line'}`} data-leg={l.key} data-state={done ? 'done' : test ? 'test' : bad ? 'failed' : waiting ? 'waiting' : l.error ? 'error' : 'todo'}>
          <div className="flex items-center gap-3"><span className="relative shrink-0"><Coin sym={l.symbol} net={a.network} size={40} />
            <span className={`absolute -right-1.5 -top-1.5 grid h-[22px] w-[22px] place-items-center rounded-full text-[11px] font-bold ring-2 ring-surface ${done ? 'bg-emerald text-white' : bad || l.error ? 'bg-danger text-[var(--ondanger)]' : waiting ? 'bg-primary text-onprimary' : 'bg-elev text-mute'}`}>{done ? <Icon n="check" className="h-3 w-3" /> : waiting ? <Icon n="spin" className="h-3 w-3" /> : bad || l.error ? <Icon n="x" className="h-3 w-3" /> : k + 1}</span></span>
            <span className="min-w-0 flex-1"><span className="block text-[15.5px] font-semibold leading-snug">{k + 1}/{legs.length} · {trimAmt(l.amount, 8)} {l.symbol}{l.key === 'gas' ? ` (${t('agGasRole')})` : ''}</span>
              <span className="mt-1 block"><Tag tone={tone} icon={done ? 'check' : test ? 'warn' : bad || l.error ? 'x' : waiting ? 'clock' : 'minus'}><span className="whitespace-normal">{done ? (l.state === 'finalized' ? t('qaFundLegFinal') : t('qaFundLegConfirming')) : test ? t('qaFundLegTest') : bad ? t('qaFundLegFailed') : waiting ? (l.state === 'broadcast' || l.state === 'signed' ? t('qaFundLegSent') : t('qaFundLegSigning')) : isNext && busy ? t('qaFundLegPasskey') : t('qaFundLegTodo')}</span></Tag></span></span></div>
          {l.error && <div className="mt-2.5"><Notice tone="danger">{l.error}</Notice></div>}
          {bad && l.txError && <div className="mt-2.5"><Notice tone="danger">{svText(t, l.txCode, l.txParams, l.txError)}</Notice></div>}
          {l.explorer && !test && <a className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-blue" href={l.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
        </li>; })}</ol>
      {stuck && <div className="mt-3"><Notice tone="warn">{t('qaFundTestMode')}</Notice></div>}
      {allDone && <div className="mt-3"><Notice tone="ok">{t('qaFundAllDone', { net: a.networkName })}</Notice></div>}
      <div className="mt-4 space-y-2.5">
        {!allDone && !stuck && !stepBtn && <p className="flex items-center gap-2 text-[13px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('qaFundWait', { net: a.networkName })}</p>}
        <ApprovalOutcomePanel ap={ap} />
        {!(allDone || stuck) && <><Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('qaFundLater')}</Btn>
          {!ap.locked && !legs.some((l) => l.proposalId && !BAD.includes(l.state ?? '')) && <Btn full kind="ghost" disabled={busy} onClick={() => setLegs(null)}>{t('qaFundAbandon')}</Btn>}</>}
        {!allDone && !stuck && <p className="text-[12.5px] leading-snug text-mute">{t('qaFundResumeNote')}</p>}
      </div>
    </Sheet>;
  }

  const nothing = cashU === 0n && gasU === 0n, blocked = cashTooMuch || cashOverPer || cashOverDay || gasTooMuch || gasOverPer || !!ov.data?.signer.halted;
  const ready = !!pf.data && !!n;
  return <Sheet title={title} onClose={onClose} busy={busy}
    footer={ready ? <Btn full busy={busy} disabled={nothing || blocked} onClick={start}><Icon n="key" />{nothing ? t('qaFundEnter') : t('qaFundGo', { what: [cashU > 0n ? `${trimAmt(fromUnits(cashU, cashDec), 6)} ${a.cash}` : '', gasU > 0n ? `${trimAmt(fromUnits(gasU, natDec), 6)} ${natSym}` : ''].filter(Boolean).join(' + ') })}</Btn> : undefined}>
    <NetBanner net={a.network}>{t('qaFundOnly', { net: a.networkName })}</NetBanner>
    <div className="mt-3 rounded-2xl border border-line p-3.5"><div className="mb-1 text-[12.5px] font-medium text-mute">{t('qaFundTo', { net: a.networkName })}</div><Addr value={a.vaultAddress} /><div className="mt-1 text-[12.5px] leading-snug text-mute">{t('qaFundToNote')}</div></div>
    {!ready ? <div className="mt-4 space-y-3" role="status" aria-label={t('qaLoading')}><div className="skel h-[64px] !rounded-2xl" /><div className="skel h-[64px] !rounded-2xl" /><p className="flex items-center gap-2 text-[13.5px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('qaLoading')}</p></div> : <>
      <section className="mt-5" aria-label={a.cash}>
        <div className="mb-2"><label htmlFor="qa-fund-cash" className="text-[14.5px] font-semibold">{a.cash} <span className="font-normal text-mute">· {cashName} · {t('qaFundCashRole')}</span></label></div>
        <AmountBox id="qa-fund-cash" sym={a.cash} net={a.network} value={cashAmt} onChange={(v) => { setTouched(true); setCashAmt(sanitizeAmountText(v)); }}
          right={<button type="button" disabled={maxCash === 0n} onClick={() => { setTouched(true); setCashAmt(amountInputText(fromUnits(maxCash, cashDec), loc)); }} className="press min-h-11 shrink-0 rounded-full border border-line bg-surface px-3.5 text-[13px] font-semibold disabled:opacity-45">{t('max')}</button>} />
        <AmountProblem text={cashAmt} />
        <p className="mt-2 text-[12.5px] leading-snug text-mute">{t('qaFundMainHas', { amount: trimAmt(fromUnits(mainCash, cashDec), 6), sym: a.cash, net: a.networkName })}{capCash ? ` ${t('qaFundLimit', { per: trimAmt(capCash.perD, 6), day: trimAmt(capCash.dayD, 6), left: trimAmt(capCash.leftD, 6), sym: a.cash })}` : ''}</p>
        {cashTooMuch ? <div className="mt-2"><Notice tone="danger">{t('qaFundErrBalance', { sym: a.cash, net: a.networkName })}</Notice></div>
          : cashOverPer ? <div className="mt-2"><Notice tone="danger">{t('qaFundErrPerTx', { max: trimAmt(capCash!.perD, 6), sym: a.cash })}</Notice></div>
          : cashOverDay ? <div className="mt-2"><Notice tone="danger">{t('qaFundErrDaily', { left: trimAmt(capCash!.leftD, 6), sym: a.cash })}</Notice></div> : null}
        {(mainCash === 0n || cashTooMuch) && <div className="mt-2 space-y-2"><Notice tone="warn">{t('qaFundNoCash', { sym: a.cash, net: a.networkName })}{usdcElsewhere.length > 0 && <> {t('qaFundCashElsewhere')}
          <ul className="mt-2 space-y-1.5">{usdcElsewhere.map((b) => <li key={b.network} className="flex items-center gap-2"><Coin sym="USDC" net={b.network} size={24} /><span className="font-medium">{trimAmt(b.display ?? '0', 6)} USDC · {b.networkName}</span></li>)}</ul></>}</Notice>
          {usdcElsewhere.filter((b) => canBridge(b.network)).map((b) => <Btn key={b.network} kind="soft" full onClick={() => toSwap(b.network)}><Icon n="swap" className="h-4 w-4 shrink-0" />{t('qaFundBridge', { from: b.networkName, to: a.networkName })}</Btn>)}
          {usdcElsewhere.length > 0 && !usdcElsewhere.some((b) => canBridge(b.network)) && <p className="text-[12.5px] text-mute">{t('qaFundNoBridge', { sym: a.cash, net: a.networkName })}</p>}</div>}
      </section>

      <section className="mt-6" aria-label={natSym}>
        <div className="mb-2"><label htmlFor="qa-fund-gas" className="text-[14.5px] font-semibold">{natSym} <span className="font-normal text-mute">· {t('qaFundGasRole')}</span></label></div>
        <AmountBox id="qa-fund-gas" sym={natSym} net={a.network} value={gasAmt} onChange={(v) => { setTouched(true); setGasAmt(sanitizeAmountText(v)); }} />
        {missing > 0n && <button type="button" onClick={() => { setTouched(true); setGasAmt(amountInputText(fromUnits(missing, natDec), loc)); }} className="press mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-elev px-4 text-[13.5px] font-semibold"><Icon n="plus" className="h-4 w-4" />{t('qaFundGasSuggest', { amount: trimAmt(fromUnits(missing, natDec), 6) })}</button>}
        <AmountProblem text={gasAmt} />
        <p className="mt-2 text-[12.5px] leading-snug text-mute">{reserve === null ? t('qaFundGasUnknown') : missing > 0n ? t('qaFundGasMissing', { reserve: trimAmt(gas!.reserve, 6), held: trimAmt(fromUnits(vNat, natDec), 6), missing: trimAmt(fromUnits(missing, natDec), 6), sym: natSym }) : t('qaFundGasOk', { reserve: trimAmt(gas!.reserve, 6), sym: natSym })} {t('qaFundMainHas', { amount: trimAmt(fromUnits(mainNat, natDec), 6), sym: natSym, net: a.networkName })}</p>
        {gasOverPer && <div className="mt-2"><Notice tone="danger">{t('qaFundErrPerTx', { max: trimAmt(capNat!.perD, 6), sym: natSym })}</Notice></div>}
        {(gasTooMuch || (mainNat === 0n && (cashU > 0n || missing > 0n))) && <div className="mt-2 space-y-2"><Notice tone="warn">{t('qaFundNoNative', { native: natSym, net: a.networkName })}{myAddr && <span className="mt-1.5 block"><Addr value={myAddr} /></span>}</Notice>
          <div className="grid grid-cols-2 gap-2">{myAddr && <CopyBtn text={myAddr} full />}<Btn kind="soft" onClick={() => nav({ tab: 'receive', network: a.network })}><Icon n="down" className="h-4 w-4" />{t('receive')}</Btn></div></div>}
      </section>

      <dl className="receipt mt-6 rounded-2xl border border-line px-4 py-1.5">
        {row(t('qaFundVaultNow'), `${trimAmt(fromUnits(vCash, cashDec), 6)} ${a.cash} · ${trimAmt(fromUnits(vNat, natDec), 6)} ${natSym}`)}
        {row(t('qaFundVaultAfter'), `${trimAmt(fromUnits(vCash + cashU, cashDec), 6)} ${a.cash} · ${trimAmt(fromUnits(vNat + gasU, natDec), 6)} ${natSym}`)}
        {row(t('qaFundPlanned'), usdCapital(a.capitalUsdc, loc))}
      </dl>
      {ov.data?.signer.halted && <div className="mt-3"><Notice tone="danger">{t('haltedBanner')}</Notice></div>}
      {ov.data?.broadcast === false && <div className="mt-3"><Notice tone="warn">{t('qaFundTestBanner')}</Notice></div>}
      <p className="mt-3 text-[12.5px] leading-snug text-mute">{cashU > 0n && gasU > 0n ? t('qaFundTwoSteps', { net: a.networkName }) : t('qaFundOneStep')}</p></>}
  </Sheet>;
}

// ── withdrawing from the agent's wallet on its own network ───────────────────────────────────────────────────────────────
export function WithdrawSheet({ a, onClose }: { a: FundAgent; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const ov = useQuery({ queryKey: ['security'], queryFn: () => get<Overview>('/security/overview'), staleTime: 15_000 });
  const [busy, setBusy] = useState(''), [err, setErr] = useState<Record<string, string>>({});
  const live = a.state === 'LIVE', rows = (a.vault ?? []).filter((x) => x.amount !== '0');
  const native = (a.vault ?? []).find((x) => x.asset === 'native'), natSym = native?.assetSymbol ?? '';
  // the native coin pays the fee of every other withdrawal: it leaves last
  const ordered = [...rows].sort((x, y) => Number(x.asset === 'native') - Number(y.asset === 'native'));
  // v8: the server tracks the withdrawal (signed → broadcast → confirmed | failed | not_sent); the sheet follows it
  const wd = useTrackedWithdrawals(a.id, () => { void qc.invalidateQueries({ queryKey: ['agent', a.id] }); });
  const go = async (x: VaultRow) => { setBusy(x.asset); setErr((m) => ({ ...m, [x.asset]: '' }));
    try { await wd.start(x.asset, { asset: x.asset }); }
    catch (e) { setErr((m) => ({ ...m, [x.asset]: (e as { code?: string }).code === 'bad_state' ? t('qaWdLive') : fundErr(t, e, { sym: x.assetSymbol, net: a.networkName, native: natSym }) })); }
    finally { setBusy(''); } };
  void ov;
  return <Sheet title={t('qaWdTitle')} onClose={onClose} busy={!!busy} footer={<Btn full kind="ghost" disabled={!!busy} onClick={onClose}>{t('qaClose')}</Btn>}>
    <NetBanner net={a.network}>{t('qaWdFrom', { name: a.name, net: a.networkName })}</NetBanner>
    <p className="mt-3 text-[13.5px] leading-snug text-mute">{t('qaWdIntro', { native: natSym })}</p>
    {live && <div className="mt-3"><Notice tone="warn">{t('qaWdLive')}</Notice></div>}
    {ordered.length === 0 ? <div className="mt-4 flex items-center gap-3.5 rounded-2xl bg-elev/60 px-4 py-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface text-mute"><Icon n="down" /></span><p className="text-[14px] text-mute">{t('qaWdEmpty')}</p></div> : <ul className="mt-4 space-y-2.5">{ordered.map((x) => <li key={x.asset} className="rounded-2xl border border-line p-3.5">
      <div className="flex items-center gap-3"><Coin sym={x.assetSymbol} net={a.network} size={40} />
        <span className="min-w-0 flex-1"><span className="t-num block text-[17px]">{trimAmt(x.display, 8)} <span className="text-mute">{x.assetSymbol}</span></span><span className="block text-[12.5px] leading-snug text-mute">{x.name}{x.asset === 'native' ? ` · ${t('qaWdNativeLast')}` : ''}</span></span>
        <Btn kind="soft" className="shrink-0" disabled={live || (!!busy && busy !== x.asset) || (!!wd.byKey[x.asset] && WD_OPEN.includes(wd.byKey[x.asset]!.state))} busy={busy === x.asset} onClick={() => void go(x)}>{t('agWithdraw')}</Btn></div>
      {wd.byKey[x.asset] && <div className="mt-3"><WdNotice w={wd.byKey[x.asset]!} /></div>}
      {err[x.asset] && <div className="mt-3"><Notice tone="danger">{err[x.asset]}</Notice></div>}
    </li>)}</ul>}
  </Sheet>;
}

/** One withdrawal as the server reports it. Green only when it is mined AND arrived at the owner's address. */
export function WdNotice({ w }: { w: Wd }) {
  const t = useT(), n = withdrawalNotice(w); const { locale } = useContext(I18n);
  return <Notice tone={n.tone}><span data-testid="wd-state" data-state={w.state} className="flex items-start gap-2">{n.pending && <Icon n="spin" className="mt-0.5 h-4 w-4 shrink-0" />}
    <span>{t(n.key, { amount: trimAmt(w.amount, 8), sym: w.symbol })}{(w.state === 'failed' || (w.state === 'confirmed' && !w.arrived)) && w.error ? <span className="mt-1 block text-[12.5px] opacity-80">{srvText(t, locale, w.error)}</span> : null}</span></span>
    {w.explorer && <a className="mt-1 flex min-h-11 items-center gap-1.5 font-medium text-blue" href={w.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}</Notice>;
}

// ── funds the vault's address holds on networks the agent does not trade on ──────────────────────────────────────────────
export function ElsewhereFunds({ a }: { a: FundAgent }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agent-elsewhere', a.id], queryFn: () => get<{ holdings: Elsewhere[] }>(`/agents/${a.id}/elsewhere`), refetchInterval: 30_000 });
  const pf = usePortfolio(), nets = useNetworks();
  const ov = useQuery({ queryKey: ['security'], queryFn: () => get<Overview>('/security/overview'), staleTime: 15_000 });
  const [busy, setBusy] = useState(''), [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [top, setTop] = useState<Record<string, { id: string; state: string; error: string | null }>>({});
  const pending = Object.entries(top).find(([, v]) => !OK.includes(v.state) && !BAD.includes(v.state) && v.state !== NOT_SENT);
  const live = useQuery({ queryKey: ['proposal', pending?.[1].id], enabled: !!pending, refetchInterval: 3000, queryFn: () => get<Proposal>(`/transfers/proposals/${pending![1].id}`) });
  useEffect(() => { const p = live.data; if (!p || !pending || p.id !== pending[1].id) return; if (p.state === pending[1].state && p.error === pending[1].error) return;
    setTop((m) => ({ ...m, [pending[0]]: { id: p.id, state: p.state, error: p.error } })); if (OK.includes(p.state)) void qc.invalidateQueries({ queryKey: ['agent-elsewhere', a.id] });
  }, [live.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = q.data?.holdings ?? [];
  // v8: tracked withdrawals — the row says signed / broadcast / confirmed / failed / not sent as the server reports it
  const wd = useTrackedWithdrawals(a.id, () => { void qc.invalidateQueries({ queryKey: ['agent-elsewhere', a.id] }); });
  const topKeys = useRef<Record<string, DraftKey>>({}), topAp = useApprovalOutcome<Proposal>();
  const byNet = useMemo(() => { const m = new Map<string, Elsewhere[]>(); for (const h of list) m.set(h.network, [...(m.get(h.network) ?? []), h]);
    // tokens first: the native coin pays their withdrawal fee and leaves last
    return [...m.entries()].map(([k, v]) => [k, [...v].sort((x, y) => Number(x.asset === 'native') - Number(y.asset === 'native'))] as [string, Elsewhere[]]); }, [list]);
  if (list.length === 0) return null;
  const key = (h: Elsewhere) => `${h.network}:${h.asset}`;
  const withdraw = async (h: Elsewhere) => { setBusy(key(h)); setMsg((m) => ({ ...m, [key(h)]: { ok: true, text: '' } }));
    try { await wd.start(key(h), { asset: h.asset, network: h.network }); }
    catch (e) { setMsg((m) => ({ ...m, [key(h)]: { ok: false, text: fundErr(t, e, { sym: h.symbol, net: h.networkName, native: h.gas }) } })); } finally { setBusy(''); } };
  return <div className="mt-5 border-t border-line pt-5" data-testid="agent-elsewhere">
    <div className="mb-2.5 flex items-center gap-2 text-[15.5px] font-semibold"><Icon n="warn" className="h-[18px] w-[18px] shrink-0 text-warn" />{t('qaElseTitle')}</div>
    <Notice tone="warn">{t('qaElseIntro', { network: a.networkName })}</Notice>
    <ApprovalOutcomePanel ap={topAp} className="mt-3" />
    <div className="mt-3 space-y-3">{byNet.map(([net, hs]) => { const h0 = hs[0]!, n = nets.data?.find((x) => x.id === net), dec = n?.native.decimals ?? 18;
      const tokens = hs.filter((h) => h.asset !== 'native'), lacking = tokens.length > 0 && (h0.gasEnough === false || (h0.gasEnough == null && !h0.hasGas));
      const need = h0.gasNeed ? toUnits(h0.gasNeed, dec) : 0n, held = toUnits(h0.gasHeld ?? '0', dec);
      // enough for every token of this network, with a margin for a fee that moves; rounded up
      const send = ceilTo((need * BigInt(tokens.length) * 3n) / 2n - held, dec, 6), sendD = fromUnits(send > 0n ? send : 0n, dec);
      const mainNat = BigInt(pf.data?.balances.find((b) => b.network === net && b.asset === 'native')?.amount ?? '0');
      const tp = top[net], tpTest = !!tp && tp.state === NOT_SENT;
      const topUp = async () => { setBusy(`gas${net}`); setMsg((m) => ({ ...m, [`gas${net}`]: { ok: true, text: '' } }));
        const say = (text: string) => setMsg((m) => ({ ...m, [`gas${net}`]: { ok: false, text } })), ctx = { sym: h0.gas, net: h0.networkName, native: h0.gas };
        const took = (p: Proposal) => setTop((m) => ({ ...m, [net]: { id: p.id, state: p.state, error: p.error } }));
        // NEXT W1: the same idempotency key for the same top-up until the server has answered; the approval's outcome is read from the server
        const dk = topKeys.current[net] ??= new DraftKey(); let d: { proposal: Proposal; assertion?: unknown };
        try { d = await draftTransfer({ network: net, asset: 'native', to: a.vaultAddress, amount: sendD, note: `Agent ${a.name}`, idem: dk.for(`${net}|${sendD}`) }); }
        catch (e) { dk.failed(e); say(fundErr(t, e, ctx)); setBusy(''); return; }
        if (d.assertion === undefined) { took(d.proposal); setBusy(''); return; }
        const pid = d.proposal.id;
        await topAp.run({ submit: () => post<Proposal>(`/transfers/proposals/${pid}/approve`, { assertion: d.assertion }), read: () => get<Proposal>(`/transfers/proposals/${pid}`), applied: proposalApplied }, (o) => {
          if (o.kind === 'refused') { dk.renew(); say(fundErr(t, o.error, ctx)); return; }
          if (o.kind === 'read' && !o.applied) return;   // said by the panel; the same key resumes this very transfer
          dk.renew(); took(o.kind === 'answered' ? o.value : o.state);
        });
        setBusy(''); };
      return <section key={net} className="rounded-2xl border border-line p-3.5" aria-label={h0.networkName}>
        <div className="mb-2.5 flex items-center gap-2 text-[14.5px] font-semibold"><NetDot net={net} size={22} />{h0.networkName}</div>
        <ul className="divide-y divide-line">{hs.map((h) => <li key={key(h)} className="py-2.5 first:pt-0 last:pb-0">
          <div className="flex items-center gap-3"><Coin sym={h.symbol} net={h.network} size={36} /><span className="min-w-0 flex-1"><span className="t-num block text-[16px]">{trimAmt(h.display, 8)} {h.symbol}</span>{h.asset === 'native' && <span className="block text-[12.5px] text-mute">{t('qaWdNativeLast')}</span>}</span>
            <Btn kind="soft" className="shrink-0" busy={busy === key(h)} disabled={(!!busy && busy !== key(h)) || (h.asset !== 'native' && lacking) || (!!wd.byKey[key(h)] && WD_OPEN.includes(wd.byKey[key(h)]!.state))} onClick={() => void withdraw(h)}>{t('agWithdraw')}</Btn></div>
          {wd.byKey[key(h)] && <div className="mt-2.5"><WdNotice w={wd.byKey[key(h)]!} /></div>}
          {msg[key(h)]?.text && <div className="mt-2.5"><Notice tone={msg[key(h)]!.ok ? 'ok' : 'danger'}>{msg[key(h)]!.text}</Notice></div>}</li>)}</ul>
        {lacking && <div className="mt-3 space-y-2"><Notice tone="info">{h0.gasNeed ? t('qaElseNeedGas', { native: h0.gas, net: h0.networkName, need: trimAmt(h0.gasNeed, 8), held: trimAmt(h0.gasHeld ?? '0', 8) }) : t('agElsewhereGas', { gas: h0.gas })}</Notice>
          {tp && !BAD.includes(tp.state) && !tpTest ? <p className="flex items-center gap-2 text-[13px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('qaElseGasSent', { native: h0.gas })}</p>
            : tpTest ? <Notice tone="warn">{t('qaFundTestMode')}</Notice>
            : topAp.locked ? null
            : h0.gasNeed && mainNat > send ? <Btn full kind="soft" busy={busy === `gas${net}`} disabled={!!busy && busy !== `gas${net}`} onClick={() => void topUp()}><Icon n="key" className="h-4 w-4 shrink-0" />{t('qaElseSendGas', { amount: trimAmt(sendD, 6), native: h0.gas, net: h0.networkName })}</Btn>
            : <p className="text-[12.5px] text-mute">{t('qaElseNoMainGas', { native: h0.gas, net: h0.networkName })}</p>}
          {msg[`gas${net}`]?.text && !topAp.locked && <Notice tone="danger">{msg[`gas${net}`]!.text}</Notice>}</div>}
      </section>; })}</div>
  </div>;
}

// ── readiness checklist ──────────────────────────────────────────────────────────────────────────────────────────────────
export function AgentChecklist({ a, gas, approved, busy, onFund, onStrategy, onPaper, onLive }: { a: FundAgent; gas: GasInfo | null; approved: boolean; busy: string; onFund: () => void; onStrategy: () => void; onPaper: () => void; onLive: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const nat = (a.vault ?? []).find((x) => x.asset === 'native'), natSym = nat?.assetSymbol ?? '', planned = Number(a.capitalUsdc), reserveN = gas ? Number(gas.reserve) : 0;
  // capital = everything the strategy can use: the fee reserve is not part of it, even when the agent trades the native coin
  const usd = (a.vault ?? []).reduce((s, x) => { if (x.role === 'gas' || x.usd === null) return s; if (x.asset !== 'native') return s + x.usd; const d = Number(x.display); return s + (d > 0 ? (x.usd * Math.max(0, d - reserveN)) / d : 0); }, 0);
  const fundsOk = a.vault !== null && usd >= planned * 0.98, fundsSome = usd > 0;
  const gasOk = !!gas && !!nat && Number(nat.display) >= Number(gas.reserve);
  const live = a.state === 'LIVE', paper = a.state === 'PAPER_TRADING';
  const f = (v: number) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: 2 }).format(v);
  // each step says its state with an icon and a word; the ring counts the steps that are fully done
  const steps: { ok: boolean | 'part'; label: string; detail: string; id: string }[] = [
    { ok: fundsOk ? true : fundsSome ? 'part' : false, label: t('qaChkFunds'), detail: a.vault === null ? t('qaChkUnknown') : t('qaChkFundsDetail', { have: f(usd), planned: f(planned), cash: a.cash, net: a.networkName }), id: 'funds' },
    { ok: gasOk, label: t('qaChkGas', { native: natSym }), detail: !gas ? t('qaFundGasUnknown') : t('qaChkGasDetail', { have: trimAmt(nat?.display ?? '0', 6), need: trimAmt(gas.reserve, 6), native: natSym }), id: 'gas' },
    { ok: approved, label: t('qaChkStrategy'), detail: approved ? t('qaChkStrategyOk') : t('agNeedsStrategy'), id: 'strategy' },
    { ok: live || paper ? true : false, label: t('qaChkMode'), detail: live ? t('qaChkModeLive') : paper ? t('qaChkModePaper') : t('qaChkModeOff'), id: 'mode' },
  ];
  const done = steps.filter((s) => s.ok === true).length;
  const next = live ? null : !fundsOk || (!gasOk && fundsSome && approved) ? { label: fundingInProgress(a.id) ? t('qaFundResume') : !fundsOk ? t('qaFundOpen') : t('qaChkAddGas', { native: natSym }), on: onFund, icon: 'up', id: 'fund' }
    : !approved ? { label: t('qaChkPickStrategy'), on: onStrategy, icon: 'list', id: 'strategy' }
    : !paper ? { label: t('agStartPaper'), on: onPaper, icon: 'clock', id: 'paper' }
    : gasOk ? { label: t('agGoLive'), on: onLive, icon: 'key', id: 'live' } : { label: t('qaChkAddGas', { native: natSym }), on: onFund, icon: 'up', id: 'fund' };
  return <section className="card p-5" aria-label={t('qaChkTitle')} data-testid="agent-checklist">
    <div className="flex items-center gap-4"><ProgressRing done={done} total={steps.length} size={60} label={t('dzAgChkProgress', { done, total: steps.length })} />
      <div className="min-w-0"><h2 className="text-[17px] font-semibold tracking-[-0.015em]">{t('qaChkTitle')}</h2><p className="mt-0.5 text-[13.5px] text-mute">{done === steps.length ? t('dzAgChkAllDone') : t('dzAgChkProgress', { done, total: steps.length })}</p></div></div>
    <ul className="mt-3 divide-y divide-line">{steps.map((s) => <li key={s.id} className="flex items-start gap-3 py-3 last:pb-1" data-check={s.id} data-ok={String(s.ok)}>
      <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${s.ok === true ? 'bg-emerald/12 text-emerald' : s.ok === 'part' ? 'bg-warn/12 text-warn' : 'bg-elev text-mute'}`} aria-hidden="true"><Icon n={s.ok === true ? 'check' : s.ok === 'part' ? 'clock' : 'minus'} className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[14.5px] font-semibold leading-snug">{s.label}</span>
        <Tag tone={s.ok === true ? 'ok' : s.ok === 'part' ? 'warn' : 'mute'} icon={s.ok === true ? 'check' : s.ok === 'part' ? 'clock' : 'minus'}>{s.ok === true ? t('qaChkYes') : s.ok === 'part' ? t('dzAgChkPart') : t('qaChkNo')}</Tag></span>
        <span className="mt-0.5 block text-[13px] leading-snug text-mute">{s.detail}</span></span></li>)}</ul>
    {next && <Btn full className="mt-3" busy={busy === next.id} onClick={next.on} data-next={next.id}><Icon n={next.icon} className="h-4 w-4" />{next.label}</Btn>}
  </section>;
}

/** Notice for the Send screen: the typed recipient is one of the owner's agent wallets. */
export function AgentRecipientNotice({ to, network, networkName }: { to: string; network: string; networkName: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['agents'], queryFn: () => get<{ agents: { id: string; name: string; network: string; networkName: string; vaultAddress: string; cash: string }[] }>('/agents'), staleTime: 60_000, enabled: /^0x[0-9a-fA-F]{40}$/.test(to) });
  const ag = q.data?.agents.find((x) => x.vaultAddress.toLowerCase() === to.toLowerCase());
  if (!ag) return null;
  return ag.network === network ? <Notice tone="info">{t('qaSendAgent', { name: ag.name, net: ag.networkName })}</Notice>
    : <Notice tone="danger"><b>{t('qaSendAgentWrongNet', { name: ag.name, agentNet: ag.networkName, net: networkName })}</b> {t('qaSendAgentWrongNetHow', { agentNet: ag.networkName })}</Notice>;
}
