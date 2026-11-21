/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/screens/Swap.tsx
 * Module           : screens
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post } from '../api';
import { usePortfolio, useSettings } from '../hooks';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Coin, EmptyState, ErrorState, exactAmt, Fact, fiat, Fold, Icon, inputCls, NetDot, Notice, numFmt, PageTitle, ProviderIcon, Section, Seg, Sheet, StatePill, Tag, testNotSent, trimAmt } from '../ui';
import { amountInputText, amountOf, sanitizeAmountText } from '../amount'; // v8 hardening
import { AmountProblem } from '../amountUi';
import { issuerOf } from '../issuer';
import { useQueryClient } from '@tanstack/react-query';
import { BridgeFacts, BridgePill, BridgeProgress, bridgeDur, ExplorerLink, LongFact, ReviewAmount, ReviewArrow, scErrText } from '../bridge';
import { XswapPill, XswapSheet } from '../xswap';
import { PlanCards } from '../plan'; // v7 any-to-any plans
import { ExecutionTimeline } from '../execution';                 // v11: unified execution status
import { execReason, flagDetail, propError } from '../sv';       // v11: server texts by code
import type { ApiError } from '../api';
import { answerLost, cancelDraft, proposalApplied, proposalGone } from '../approval';   // NEXT W1: the outcome of an approval is what the server says
import { ApprovalOutcomePanel, useApprovalOutcome, type KnownOutcome } from '../approvalUi';
import { heroOf, prepareOf, type Executor, type QuoteRefV } from '../swapLogic'; // v11: what is shown is what is executed (B1, B6)

interface SAsset { key: string; network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; native?: boolean }
interface Fee { kind: string; symbol: string; network: string; display: string; includedInOutput: boolean; estimated: boolean; usd: number | null }
interface BridgeQuote { options: { speed: 'standard' | 'fast'; available: boolean; feeDisplay: string; minReceiveDisplay: string; seconds: number; quote?: QuoteRefV | null }[]; destinationGas: { symbol: string; needDisplay: string; balanceDisplay: string; enough: boolean }; toName: string; fromName: string;
  /** v8: Solana as source (refundable deposit) or destination (the wallet's USDC token account, which must exist) */
  solana?: { role: 'source'; depositDisplay: string; networkFeeDisplay: string } | { role: 'destination'; recipient: string; tokenAccount: string; tokenAccountExists: boolean; tokenAccountRentDisplay: string; nonceRentDisplay: string } }
/** v11: the normalized route card — the same object for every route; a figure the provider does not give is null (packages/swap/src/card.ts) */
interface CardFeeV { usd: number | null; estimated?: boolean; includedInOutput: boolean; bps?: number | null; items: { kind: string; network: string; symbol: string; display: string; estimated: boolean; includedInOutput: boolean; usd: number | null }[] }
interface CardV { quoteId: string; fingerprint: string; fromSymbol: string; toSymbol: string; amountInDisplay: string; estimatedOutDisplay: string; minimumOutDisplay: string; networkFee: CardFeeV | null; protocolFee: CardFeeV | null;
  toleranceBps: number; effectiveSlippageBps: number | null; etaSeconds: number | null; riskFlags: string[]; steps: { kind: string; network: string; toNetwork: string; provider: string; descriptionCode: string }[];
  quotedAt: number; expiresAt: number; executable: boolean; executor: string | null; reasonCode: string | null }
interface RouteV { id: string; executable: boolean; /** v11: who executes it — stated by the server from its pinned tables, never inferred here */ executor?: Executor | null; fingerprint?: string; quotedAt?: number; amountOut?: string; minAmountOut?: string; card?: CardV;
  exec?: { via: Executor; speed?: 'standard' | 'fast' | null } | null; providers: string[]; path: SAsset[]; tags: string[]; pareto: boolean; amountOutDisplay: string; minAmountOutDisplay: string; estimatedSeconds: number | null; expiresAt: number;
  executability: { class: 'verified' | 'opaque' | 'quote_only'; reason?: string; code?: string }; valuation: { inUsd: number | null; outUsd: number | null; minOutUsd: number | null; extraFeesUsd: number; netUsd: number | null };
  risk: { level: 'low' | 'medium' | 'high'; score: number; flags: { code: string; level: string; detail?: string; params?: Record<string, string | number> }[] }; atomic: boolean; refundable: boolean | null; priceImpactBps: number | null;
  steps: { kind: string; provider: string; from: SAsset; to: SAsset; via: string[]; contracts: { network: string; address: string; role: string }[] }[]; fees: Fee[] }
interface Prov { provider: string; status: string; code: string | null; ms: number }
type Mode = 'best_price' | 'fastest' | 'balanced';

const dur = (s: number | null, t: (k: Key, v?: Record<string, string | number>) => string) => (s === null ? t('swUnknownTime') : s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** the hero numeral keeps its size as long as it fits; a long amount steps down rather than being cut */
const heroSize = (len: number) => (len <= 9 ? 'text-[2.5rem]' : len <= 12 ? 'text-[2.0625rem]' : len <= 16 ? 'text-[1.625rem]' : 'text-[1.3125rem]');

/** Asset picker: a sheet above the tab bar — search, then the assets (held first), each with its real logo, its network and, for a pegged or bridged token, its issuer. */
function Picker({ open, onClose, onPick, assets, balances, exclude }: { open: boolean; onClose: () => void; onPick: (a: SAsset) => void; assets: SAsset[]; balances: Map<string, string>; exclude?: string }) {
  const t = useT(); const [q, setQ] = useState(''); const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => { const s = q.trim().toLowerCase();
    return assets.filter((a) => a.key !== exclude && (!s || a.symbol.toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || a.networkName.toLowerCase().includes(s)))
      .sort((a, b) => Number(!['0', '?'].includes(balances.get(b.key) ?? '0')) - Number(!['0', '?'].includes(balances.get(a.key) ?? '0')) || Number(!!b.native) - Number(!!a.native) || a.symbol.localeCompare(b.symbol)).slice(0, 80); }, [q, assets, balances, exclude]);
  useEffect(() => { if (open) { setQ(''); input.current?.focus(); } }, [open]);   // after the sheet took the focus: the search field is where typing goes
  if (!open) return null;
  return (
    <Sheet title={t('swChoose')} onClose={onClose} wide>
      <div className="sticky top-0 z-[1] -mx-1 bg-surface px-1 pb-3 pt-1"><div className="relative"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
        <input ref={input} className={`${inputCls} !pl-11`} type="search" placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div></div>
      <ul className="-mx-2 min-h-[52dvh] lg:min-h-[340px]">{rows.map((a) => { const b = balances.get(a.key), iss = issuerOf(t, a.symbol, a.name); return (
        <li key={a.key}><button onClick={() => { onPick(a); onClose(); }} className="row-press flex min-h-[64px] w-full items-center gap-3.5 rounded-2xl px-2 py-2.5 text-left">
          <Coin sym={a.symbol} net={a.network} size={42} />
          <span className="min-w-0 flex-1"><span className="block truncate text-[0.96875rem] font-semibold">{a.symbol} <span className="font-normal text-mute">{a.name}</span></span><span className="mt-0.5 block text-[0.8125rem] leading-snug text-mute">{a.networkName}{iss ? <> · <span className="text-warn">{t(`qaTag_${iss.kind}` as Key)}</span> — {iss.text}</> : null}</span></span>
          {b && b !== '0' && b !== '?' && <span className="shrink-0 text-[0.90625rem] font-semibold">{trimAmt(b)}</span>}</button></li>); })}
        {rows.length === 0 && <li className="flex flex-col items-center px-6 py-12 text-center"><span className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-elev text-mute"><Icon n="search" className="h-5 w-5" /></span><span className="text-[0.90625rem] text-mute">{t('noMatch')}</span></li>}</ul>
    </Sheet>);
}
/** Skeleton of a route card: provider logo and name, the figure, the minimum line, the three facts. */
function RouteSkeleton() {
  return <div className="card p-4" aria-hidden="true"><div className="flex items-center gap-3"><div className="skel h-9 w-9 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-3.5 w-28 !rounded-md" /><div className="skel h-3 w-24 !rounded-md" /></div></div>
    <div className="skel mt-4 h-7 w-48 max-w-full !rounded-lg" /><div className="skel mt-2.5 h-3 w-56 max-w-full !rounded-md" />
    <div className="mt-4 grid grid-cols-3 gap-2">{[0, 1, 2].map((k) => <div key={k} className="skel h-10 !rounded-xl" />)}</div></div>;
}

export function Swap() {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const pf = usePortfolio();
  const assetsQ = useQuery({ queryKey: ['swap-assets'], queryFn: () => get<{ assets: SAsset[] }>('/swap/assets'), staleTime: 600_000 });
  const provQ = useQuery({ queryKey: ['swap-providers'], queryFn: () => get<{ executionEnabled: boolean; providers: { id: string; name: string; state: string; enabled: boolean; p50: number | null; capabilities: { needsKey: boolean; configured: boolean } }[]; needsKey?: string[] }>('/swap/providers'), staleTime: 30_000 });
  const assets = assetsQ.data?.assets ?? [];
  const [fromKey, setFromKey] = useState(''), [toKey, setToKey] = useState(''), [amountText, setAmount] = useState(''), [slip, setSlip] = useState(50), [mode, setMode] = useState<Mode>('best_price');
  // v8 hardening: the field keeps what was typed (comma or point); `amount` is its canonical reading (amount.ts) — '' while it is empty, invalid or ambiguous
  const amount = amountOf(amountText, locale) ?? '';
  const [pick, setPick] = useState<'from' | 'to' | null>(null), [open, setOpen] = useState(''), [again, setAgain] = useState(0);   // v10: `again` restarts the quote stream (« Réessayer » of the error state)
  const [routes, setRoutes] = useState<RouteV[]>([]), [best, setBest] = useState<Partial<Record<Mode, string>>>({}), [provs, setProvs] = useState<Prov[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle'), [reachable, setReachable] = useState(true), [took, setTook] = useState<number | null>(null), [first, setFirst] = useState<number | null>(null);
  const es = useRef<EventSource | null>(null);
  // v11: the executors the SERVER states for this pair (`start` event), a slow clock for the age of the quotes, and one
  // Idempotency-Key per attempt — repeated after a lost answer, so that the retry finds the proposal instead of making a second one
  const [pairExec, setPairExec] = useState<Executor[]>([]), [now, setNow] = useState(() => Date.now()); const attempt = useRef<{ sig: string; key: string } | null>(null);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(h); }, []);
  const qc = useQueryClient();
  const [exec, setExec] = useState<{ proposal: any; options: any } | null>(null), [busy, setBusy] = useState(''), [execErr, setExecErr] = useState(''), [left, setLeft] = useState(0);
  const execAp = useApprovalOutcome<any>();
  const live = useQuery({ queryKey: ['proposal', exec?.proposal.id], enabled: !!exec && !['pending_approval'].includes(exec.proposal.state), refetchInterval: 3000, queryFn: () => get<any>(`/transfers/proposals/${exec!.proposal.id}`) });
  const prop = live.data ?? exec?.proposal;
  useEffect(() => { if (!exec || exec.proposal.state !== 'pending_approval') return; const tick = () => setLeft(Math.max(0, Math.round((new Date(exec.proposal.expiresAt).getTime() - Date.now()) / 1000))); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [exec]);
  useEffect(() => { if (prop?.state === 'finalized' || prop?.bridge?.stage === 'done' || prop?.xswap?.done) void qc.invalidateQueries({ queryKey: ['portfolio'] }); }, [prop?.state, prop?.bridge?.stage, prop?.xswap?.done, qc]);
  const balances = useMemo(() => new Map((pf.data?.balances ?? []).map((b) => [`${b.network}:${b.asset === 'native' ? 'native' : b.asset.startsWith('0x') ? b.asset.toLowerCase() : b.asset}`, b.display ?? '?'])), [pf.data]);
  const by = (k: string) => assets.find((a) => a.key === k);
  useEffect(() => { // sensible defaults once the registry is loaded
    if (!assets.length || fromKey) return;
    // pre-filled cross-network USDC transfer (link from the venue deposit screen): /swap?bridgeFrom=<network>&bridgeTo=<network>[&amount=…]
    const q = new URLSearchParams(location.search), u = (n: string | null) => assets.find((a) => a.network === n && a.symbol === 'USDC'), bf = u(q.get('bridgeFrom')), bt = u(q.get('bridgeTo'));
    if (bf && bt && bf.key !== bt.key) { setFromKey(bf.key); setToKey(bt.key); const am = q.get('amount'); if (am && /^\d+(\.\d{1,6})?$/.test(am)) setAmount(amountInputText(am, locale)); return; }
    // arriving from "fund the agent": USDC from one network to the agent's network, prefilled once
    try { const pre = JSON.parse(sessionStorage.getItem('spw-swap-prefill') ?? 'null') as { fromNetwork: string; toNetwork: string; symbol: string } | null; sessionStorage.removeItem('spw-swap-prefill');
      const f = pre && assets.find((a) => a.network === pre.fromNetwork && a.symbol === pre.symbol), g = pre && assets.find((a) => a.network === pre.toNetwork && a.symbol === pre.symbol);
      if (f && g) { setFromKey(f.key); setToKey(g.key); return; } } catch { /* no prefill */ }
    const usdc = assets.find((a) => a.network === 'base' && a.symbol === 'USDC'), eth = assets.find((a) => a.network === 'base' && a.native);
    if (usdc && eth) { setFromKey(usdc.key); setToKey(eth.key); }
  }, [assets, fromKey]);
  const from = by(fromKey), to = by(toKey);
  // v7 any-to-any: a cross-network pair also gets multi-leg plans (apps/web/src/plan.tsx); single-leg flows below are unchanged
  const crossNet = !!from && !!to && from.network !== to.network; const [planCount, setPlanCount] = useState(0);
  // USDC -> USDC between two networks served by CCTP: executed by the wallet itself (burn, attestation, mint)
  const brNets = useQuery({ queryKey: ['bridge-exec'], queryFn: () => get<{ networks: string[] }>('/bridge/execution'), staleTime: 600_000 });
  const isBridge = !!from && !!to && from.symbol === 'USDC' && to.symbol === 'USDC' && from.network !== to.network && !!brNets.data?.networks.includes(from.network) && brNets.data.networks.includes(to.network);
  const amountOk = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  const [speed, setSpeed] = useState<'standard' | 'fast'>('standard');
  const brQ = useQuery({ queryKey: ['bridge-quote', from?.network, to?.network, amount], enabled: isBridge && amountOk, staleTime: 20_000, retry: false, queryFn: () => get<BridgeQuote>(`/bridge/quote?from=${from!.network}&to=${to!.network}&amount=${encodeURIComponent(amount)}`) });
  const brSpeed = brQ.data?.options.find((o) => o.speed === speed && o.available) ? speed : 'standard';
  // v8, toward Solana: the wallet's USDC token account must exist before anything is burned; creating it is a small passkey-approved transaction
  const brSol = brQ.data?.solana, ataMissing = brSol?.role === 'destination' && !brSol.tokenAccountExists;
  const [ataBusy, setAtaBusy] = useState(false), [ataMsg, setAtaMsg] = useState(''), [ataErr, setAtaErr] = useState('');
  const ataAp = useApprovalOutcome<BridgeQuote>();
  const createAta = async () => {
    setAtaBusy(true); setAtaErr(''); setAtaMsg('');
    let o: { requestId: string; options: any }, assertion;
    try {
      o = await post<{ requestId: string; options: any }>('/bridge/solana/token-account/options');
      assertion = await startAuthentication({ optionsJSON: o.options });
    } catch (e) { const m = scErrText(t, e); if (m) setAtaErr(m); setAtaBusy(false); return; }
    const later = () => { for (const ms of [4000, 9000, 16000, 30000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ['bridge-quote'] }), ms); };
    // a lost answer: the quote is read again — it says whether the token account exists now (the creation may still be confirming)
    await ataAp.run({ submit: () => post<{ sent: boolean }>('/bridge/solana/token-account', { requestId: o.requestId, assertion }),
      read: () => get<BridgeQuote>(`/bridge/quote?from=${from!.network}&to=${to!.network}&amount=${encodeURIComponent(amount)}`), applied: (q) => q.solana?.role === 'destination' && q.solana.tokenAccountExists }, (r) => {
      if (r.kind === 'refused') { const m = scErrText(t, r.error); if (m) setAtaErr(m); return; }
      if (r.kind === 'answered') setAtaMsg(r.value.sent ? t('scAtaCreating') : t('scAtaNotSent')); else if (!r.applied) setAtaMsg(t('nxAtaNotSeen'));
      void qc.invalidateQueries({ queryKey: ['bridge-quote'] }); later();
    });
    setAtaBusy(false);
  };
  const cur = settings.currency, rate = pf.data?.prices ? (cur === 'USD' ? 1 : (pf.data.prices.USDC?.cad ?? 0) / (pf.data.prices.USDC?.usd || 1)) : null;
  const money = (usd: number | null) => (usd === null || rate === null ? null : fiat(usd * rate, cur, locale));

  // live quotes: one server-sent stream per (pair, amount, slippage), restarted after a short pause in typing
  useEffect(() => {
    es.current?.close(); setRoutes([]); setBest({}); setProvs([]); setTook(null); setFirst(null); setOpen(''); setPairExec([]);
    if (!from || !to || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) { setPhase('idle'); return; }
    setPhase('loading');
    const h = setTimeout(() => {
      const t0 = performance.now();
      const s = new EventSource(`/api/v1/swap/quote/stream?from=${encodeURIComponent(from.key)}&to=${encodeURIComponent(to.key)}&amount=${encodeURIComponent(amount)}&slippageBps=${slip}`);
      es.current = s;
      s.addEventListener('start', (e) => { const d = JSON.parse((e as MessageEvent).data) as { reachable: boolean; executors?: Executor[] }; setReachable(d.reachable); setPairExec(d.executors ?? []); });
      s.addEventListener('route', (e) => { const r = JSON.parse((e as MessageEvent).data) as RouteV; setFirst((f) => f ?? Math.round(performance.now() - t0)); setRoutes((rs) => [...rs.filter((x) => x.id !== r.id), r]); });
      s.addEventListener('provider', (e) => setProvs((p) => [...p, JSON.parse((e as MessageEvent).data)]));
      s.addEventListener('done', (e) => { const d = JSON.parse((e as MessageEvent).data); setRoutes(d.routes); setBest(d.best); setTook(Math.round(performance.now() - t0)); setPhase('done'); s.close(); });
      s.addEventListener('error', () => { setPhase((p) => (p === 'done' ? p : 'error')); s.close(); });
    }, 450);
    return () => { clearTimeout(h); es.current?.close(); };
  }, [from?.key, to?.key, amount, slip, again]);

  const prepare = async () => {
    if (!from || !to) return;
    // v11 (B6): what is prepared is the route that is displayed. The executor comes from that route as the SERVER stated it (it used
    // to be guessed from which routes happened to be in the stream), and its reference travels with the request: the server refuses
    // with the fresh figures when its firm route is worse than the minimum shown here.
    const req = prepareOf({ from, to, amount, slippageBps: slip, isBridge, speed: brSpeed, option: brQ.data?.options.find((o) => o.speed === brSpeed), ex: ex ?? null });
    if (!req) return;
    const { path, body } = req;
    // the same key for the same request until it is answered: a retry after a lost answer gets the proposal that was created (B4)
    const sig = `${path}|${JSON.stringify(body)}`; if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() };
    setBusy('prepare'); setExecErr('');
    try { setExec(await post(path, body, { 'idempotency-key': attempt.current.key })); attempt.current = null; }
    catch (e) {
      const x = e as ApiError, d = (x.body as { data?: { fresh?: { amountOutDisplay: string; symbol: string }; quoted?: { minAmountOutDisplay: string } } } | undefined)?.data;
      if (!answerLost(e)) attempt.current = null; // answered (even by a refusal): the next click is a new request; a lost answer (time-out, network, 5xx) keeps the key
      const requote = () => { setAgain((n) => n + 1); void qc.invalidateQueries({ queryKey: ['bridge-quote'] }); };
      if (x.code === 'quote_moved' && d?.fresh && d.quoted) { setExecErr(t('svQuoteMoved', { fresh: trimAmt(d.fresh.amountOutDisplay, 8), min: trimAmt(d.quoted.minAmountOutDisplay, 8), sym: d.fresh.symbol })); requote(); }
      else if (x.code === 'quote_mismatch') { setExecErr(t('svQuoteStale')); requote(); }
      else if (x.code === 'quote_not_executable') setExecErr(t('svQuoteNotExec'));
      // an address that never received SOL does not exist on Solana: the server reports it as "not a plain account"
      else setExecErr(x.code === 'account_not_plain' && from.network === 'solana' && ['0', undefined].includes(balances.get('solana:native')) ? t('qaSolNotFunded') : scErrText(t, e));
    } finally { setBusy(''); }
  };
  const approve = async () => {
    if (!exec) return;
    setBusy('passkey'); setExecErr('');
    const id = exec.proposal.id, read = () => get<any>(`/transfers/proposals/${id}`);
    let assertion;
    try { assertion = await startAuthentication({ optionsJSON: exec.options }); } // the challenge is the fingerprint of this exact swap
    catch (e) { const m = errText(t, e); if (m) setExecErr(m); setBusy(''); return; }
    // the approval leaves the browser: only a state read from the server says what happened (approval.ts)
    setBusy('submit');
    await execAp.run({ submit: () => post<any>(`/transfers/proposals/${id}/approve`, { assertion }), read, applied: proposalApplied }, (o: KnownOutcome<any, any>) => {
      if (o.kind === 'refused') { const m = errText(t, o.error); if (m) setExecErr(m); void read().then((fresh) => setExec({ ...exec, proposal: fresh }), () => {}); return; }
      setExec({ ...exec, proposal: o.kind === 'answered' ? o.value : o.state }); setExecErr('');   // a state that still awaits the approval is said by the panel
    });
    setBusy('');
  };
  // closing a review cancels its draft: a cancellation that fails says so and the sheet stays; never offered while the outcome of an approval is unread
  const closeExec = async () => {
    if (execAp.locked) return;
    if (exec?.proposal.state === 'pending_approval') {
      const id = exec.proposal.id; setBusy('cancel'); setExecErr('');
      const c = await cancelDraft(() => post(`/transfers/proposals/${id}/reject`), () => get<any>(`/transfers/proposals/${id}`));
      setBusy('');
      if (c.kind === 'failed' && !(c.state && proposalGone(c.state))) { setExecErr(t('nxCancelFailed', { why: errText(t, c.error) })); if (c.state) setExec({ ...exec, proposal: c.state }); return; }
    }
    setExec(null); setExecErr(''); setAmount('');
  };
  const net = (r: RouteV) => r.valuation.netUsd ?? Number(r.minAmountOutDisplay);
  const sorted = [...routes].sort((a, b) => Number(b.id === best[mode]) - Number(a.id === best[mode]) || net(b) - net(a));
  const chosen = sorted[0];
  const flip = () => { setFromKey(toKey); setToKey(fromKey); setAmount(''); };
  const bal = from ? balances.get(from.key) : undefined;
  const noProviders = (provQ.data?.providers.length ?? 0) === 0;
  // display name of a provider id; Jupiter's licence requires its "Metis" label wherever a route of theirs is shown
  const pname = (id: string) => provQ.data?.providers.find((p) => p.id === id)?.name ?? (id === 'jupiter' ? 'Jupiter (Metis)' : id);

  // ── v10 presentation ────────────────────────────────────────────────────────────────────────────────────────────────────
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  const ex = sorted.find((r) => r.executable);
  // what stays in view: every route the wallet can execute here, and the top-ranked one whatever it is; the other
  // comparison-only quotes (never a fee or a warning of what is executed) are folded under their own title
  const shown = isBridge ? [] : sorted.filter((r, k) => r.executable || k === 0), folded = sorted.filter((r) => !shown.includes(r));
  const sep = locale === 'fr' ? ' : ' : ': ';
  // v11 (B1): « Vous recevez » is the option the action EXECUTES — the selected CCTP speed on a CCTP pair, the executable route
  // otherwise — never the top-ranked quote of another provider. With nothing executable the figure stays empty and the best
  // comparison quote is named as what it is, underneath.
  const shownHero = heroOf({ isBridge, option: brQ.data?.options.find((o) => o.speed === brSpeed), sorted }) as { hero: ReturnType<typeof heroOf>['hero']; bestOther: RouteV | null };
  const hero = shownHero.hero && { ...shownHero.hero, via: shownHero.hero.source === 'cctp' && isBridge ? t('svHeroCctp', { speed: t(brSpeed === 'fast' ? 'pnFast' : 'pnStandard') }) : t('svHeroVia', { via: pname(shownHero.hero.provider) }) };
  const heroWait = isBridge ? brQ.isLoading : phase === 'loading' && !ex;
  const bestOther = shownHero.bestOther;
  // the age of a quote, and whether it is still usable
  const quoteAge = (c: CardV) => (now >= c.expiresAt ? t('svCardExpired') : now - c.quotedAt < 90_000 ? t('svCardAgeS', { n: Math.max(0, Math.round((now - c.quotedAt) / 1000)) }) : t('svCardAgeMin', { n: Math.round((now - c.quotedAt) / 60_000) }));
  const pct = (bps: number) => numFmt(Math.abs(bps) / 100, locale, 2, 2);
  const feeLine = (f: CardFeeV | null) => (f === null ? <span className="text-mute">{t('svCardNotReported')}</span> : <>
    {f.items.map((i) => `${trimAmt(i.display, 8)} ${i.symbol}`).join(' + ')}{f.usd != null ? ` · ≈ ${money(f.usd)}` : ''}{f.bps != null ? ` (${t('svCardBps', { pct: pct(f.bps) })})` : ''}
    {(f.estimated || f.includedInOutput) && <span className="block font-normal text-mute">{[f.estimated ? t('svCardEstimated') : '', f.includedInOutput ? t('svCardIncluded') : ''].filter(Boolean).join(' · ')}</span>}</>);
  /** The normalized card of a route: the same lines, in the same order, for every provider. */
  const cardFacts = (r: RouteV) => { const c = r.card; if (!c) return null; return (
    <dl className="receipt" data-testid="route-facts" data-executable={c.executable} data-executor={c.executor ?? ''}>
      <Fact k={t('svCardSent')}>{trimAmt(c.amountInDisplay, 8)} {c.fromSymbol}</Fact>
      <Fact k={t('svCardEst')}>{trimAmt(c.estimatedOutDisplay, 8)} {c.toSymbol}</Fact>
      <Fact k={t('svCardMin')}>{trimAmt(c.minimumOutDisplay, 8)} {c.toSymbol} <span className="font-normal text-mute">· {t('svCardTolerance')} {numFmt(c.toleranceBps / 100, locale, 2)} %</span></Fact>
      <Fact k={t('svCardNetFee')} testid="fact-network-fee">{feeLine(c.networkFee)}</Fact>
      <Fact k={t('svCardProtoFee')} testid="fact-protocol-fee">{feeLine(c.protocolFee)}</Fact>
      <Fact k={t('svCardSlip')}>{c.effectiveSlippageBps === null ? <span className="text-mute">{t('svCardNoRef')}</span> : c.effectiveSlippageBps >= 0 ? t('svCardCost', { pct: pct(c.effectiveSlippageBps) }) : t('svCardGain', { pct: pct(c.effectiveSlippageBps) })}</Fact>
      <Fact k={t('svCardEta')}>{c.etaSeconds === null ? <span className="text-mute">{t('svCardNotReported')}</span> : dur(c.etaSeconds, t)}</Fact>
      <Fact k={t('svCardAge')} testid="fact-quote-age">{quoteAge(c)}</Fact>
      <Fact k={t('svCardExec')}>{c.executable && c.executor ? t('svCardExecHere', { via: pname(c.executor) }) : t('svCardExecNo')}</Fact>
    </dl>); };

  const side = (label: string, a: SAsset | undefined, which: 'from' | 'to', body: React.ReactNode) => (
    <div className={`rounded-[20px] bg-elev/60 px-4 pb-3.5 pt-3 ${which === 'from' ? 'sw-pay' : ''}`}>
      <button onClick={() => setPick(which)} className="press -ml-1 flex min-h-[52px] max-w-full items-center gap-3 rounded-2xl py-1 pl-1 pr-2 text-left" aria-label={`${label}: ${a ? `${a.symbol} ${a.networkName}` : t('swChoose')}`}>
        {a ? <Coin sym={a.symbol} net={a.network} size={44} /> : <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface text-mute"><Icon n="plus" className="h-5 w-5" /></span>}
        <span className="min-w-0"><span className="t-eyebrow block">{label}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[1.0625rem] font-semibold leading-tight tracking-[-0.015em]"><span className="min-w-0">{a ? <>{a.symbol} <span className="font-normal text-mute">· {a.networkName}</span></> : t('swChoose')}</span><Icon n="chev" className="h-4 w-4 shrink-0 rotate-90 text-mute" /></span></span>
      </button>
      {body}
    </div>);

  const routeCard = (r: RouteV) => { const isOpen = open === r.id, here = r.executable && !isBridge, top = !isBridge && r.id === sorted[0]?.id, last = r.path[r.path.length - 1]!;
    const foreign = crossNet && !r.executable && !r.providers.every((x) => ['cctp', 'kyberswap', 'jupiter', 'thorchain'].includes(x));
    const fees = r.fees.length > 0 && <div><div className="t-eyebrow mb-0.5">{t('swFees')}</div>
      <dl>{r.fees.map((f, i) => <Fact key={i} k={<>{t(`swFee_${f.kind}` as Key)}{f.estimated ? ` (${t('estimate')})` : ''}{f.includedInOutput ? ` · ${t('swIncluded')}` : ''}</>}>{trimAmt(f.display, 8)} {f.symbol}{f.usd != null ? ` · ${money(f.usd)}` : ''}</Fact>)}</dl></div>;
    const risks = <div><div className="t-eyebrow mb-1.5">{t('swRisk')}</div>
      {r.risk.flags.length === 0 ? <span className="text-mute">—</span> : <ul className="space-y-1.5">{r.risk.flags.map((f, i) => <li key={i} className="flex gap-2"><Icon n={f.level === 'low' ? 'check' : 'warn'} className={`mt-0.5 h-4 w-4 shrink-0 ${f.level === 'high' ? 'text-danger' : f.level === 'medium' ? 'text-warn' : 'text-mute'}`} /><span className="min-w-0">{t(`swFlag_${f.code}` as Key)}{flagDetail(t, f) ? <span className="text-mute"> — {flagDetail(t, f)}</span> : null}</span></li>)}</ul>}</div>;
    return (
      <section key={r.id} className={`card overflow-hidden ${top ? 'sw-chosen' : ''} ${here ? '' : 'sw-cmp'}`} data-testid="route-card" data-executable={here}>
        <button className="row-press w-full p-4 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : r.id)}>
          <div className="flex items-center gap-3">
            <span className="flex shrink-0 items-center">{r.providers.map((x, k) => <ProviderIcon key={x + k} provider={x} size={here ? 36 : 30} className={k ? '-ml-2.5 ring-2 ring-surface' : ''} />)}</span>
            <div className="min-w-0 flex-1"><div className="text-[1rem] font-semibold leading-tight tracking-[-0.01em]">{r.providers.map(pname).join(' → ')}</div>
              <div className="mt-1 flex">{here ? <Tag tone="ok" icon="check">{t('qaSwExecHere')}</Tag> : foreign ? <Tag tone="mute" icon="lock" testid="compare-only">{t('pnCompareOnly')}</Tag> : <Tag tone="mute" icon="lock">{t('qaSwCompareOnly')}</Tag>}</div></div>
            <Icon n="chev" className={`h-4 w-4 shrink-0 text-mute transition-transform ${isOpen ? '-rotate-90' : 'rotate-90'}`} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {r.tags.map((tag) => <span key={tag} className="tag bg-primary text-onprimary"><Icon n="star" className="h-3 w-3" />{t(`sw_${tag}` as Key)}</span>)}
            <Tag tone={r.risk.level === 'low' ? 'ok' : r.risk.level === 'medium' ? 'warn' : 'danger'} icon={r.risk.level === 'low' ? 'check' : 'warn'}>{t(`swRisk_${r.risk.level}` as Key)}</Tag>
          </div>
          <div className={`t-num mt-3.5 break-words ${here ? 'text-[1.75rem]' : 'text-[1.375rem]'}`}>{trimAmt(r.amountOutDisplay, 8)} <span className="text-mute">{last.symbol}</span></div>
          <div className="mt-1 text-[0.8125rem] leading-snug text-mute">{t('swMin')} <span className="font-semibold text-ink">{trimAmt(r.minAmountOutDisplay, 8)}</span>{r.valuation.netUsd != null ? ` · ${t('swNet')} ${money(r.valuation.netUsd)}` : ''}</div>
          <dl className="sw-stats mt-3.5">
            <div><dt>{t('dzSwTime')}</dt><dd>{r.estimatedSeconds === null ? <span title={t('swUnknownTime')} aria-label={t('swUnknownTime')}>—</span> : dur(r.estimatedSeconds, t)}</dd></div>
            <div><dt>{t('swFees')}</dt><dd>{r.valuation.extraFeesUsd > 0 ? money(r.valuation.extraFeesUsd) : '—'}</dd></div>
            {r.priceImpactBps !== null && <div><dt>{t('swImpact')}</dt><dd>{numFmt(r.priceImpactBps / 100, locale, 2, 2)} %</dd></div>}
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.78125rem]">{r.path.map((p, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <Icon n="chev" className="h-3 w-3 text-mute" />}<span className="inline-flex items-center gap-1.5 rounded-full bg-elev py-0.5 pl-0.5 pr-2.5 font-medium"><Coin sym={p.symbol} net={p.network} size={22} />{p.symbol}</span></span>)}</div>
        </button>
        {/* the route the wallet executes keeps its fees and its risks in view; a comparison quote shows them when opened */}
        {here && <div className="space-y-3.5 border-t border-line px-4 py-3.5 text-[0.84375rem]">{cardFacts(r)}{fees}{risks}</div>}
        {isOpen && <div className="space-y-3.5 border-t border-line px-4 py-3.5 text-[0.84375rem]">
          <div><div className="t-eyebrow mb-2">{t('swSteps')}</div>
            <ol className="space-y-2.5">{r.steps.map((s, i) => <li key={i} className="flex gap-3"><span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-elev text-[0.75rem] font-semibold">{i + 1}</span>
              <span className="min-w-0"><span className="font-semibold">{t(`swKind_${s.kind}` as Key)}</span> {s.from.symbol} ({s.from.networkName}) → {s.to.symbol} ({s.to.networkName})
                <span className="mt-0.5 flex items-center gap-1.5 text-mute"><ProviderIcon provider={s.provider} size={16} /><span className="min-w-0">{pname(s.provider)}{s.via.length ? ` · ${s.via.slice(0, 4).join(', ')}` : ''}</span></span></span></li>)}</ol></div>
          {!here && cardFacts(r)}{!here && fees}{!here && risks}
          <div className="text-mute" data-testid="route-exec-reason">{execReason(t, r.executability) || t(`swExec_${r.executability.class}` as Key)}</div>
        </div>}
      </section>); };

  // the ONE primary action of the screen, under the pair. A CCTP transfer and a plan carry their own (they depend on a choice made in their card).
  const locked = <><Btn full disabled><Icon n="lock" className="h-4 w-4" />{t('swExecuteDisabled')}</Btn>
    <p className="px-1 text-[0.8125rem] leading-snug text-mute">{t('swExecWhere')} {t('swSolIntro')}</p></>;
  const action = isBridge ? null
    : phase === 'idle' ? <Btn full disabled>{t('dzSwEnterAmount')}</Btn>
    : ex ? <><Btn full busy={busy === 'prepare'} onClick={() => void prepare()}><Icon n="swap" className="h-4 w-4" />{t('swExecute', { via: pname(ex.providers[0]!) })}</Btn>
        {ex.id !== sorted[0]!.id && <p className="flex gap-2 px-1 text-[0.8125rem] leading-snug text-mute"><Icon n="warn" className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span className="min-w-0">{t('swExecNotBest')}</span></p>}</>
    // v11: the server says this pair IS executed here (pinned tables) but the executor gave no quote in this search — say that, not "comparison only"
    : phase === 'done' && pairExec.length > 0 ? <Notice tone="warn"><span data-testid="exec-no-quote">{t('svExecNoQuote', { via: pairExec.map(pname).join(', ') })}</span></Notice>
    : crossNet ? (planCount > 0 || sorted.length === 0 ? null /* a startable plan is offered below */ : locked)
    : sorted.length === 0 ? (phase === 'loading' ? <Btn full busy>{t('swSearching')}</Btn> : phase === 'done' ? <Btn full disabled>{t('dzSwNoRouteBtn')}</Btn> : null)
    : locked;

  const review = exec && prop;
  const reviewPill = (pill: React.ReactNode) => <span className="mt-1.5 inline-flex">{pill}</span>;
  const reviewActions = prop && <div className="mt-4 space-y-2.5">
    <ApprovalOutcomePanel ap={execAp} />
    {prop.state === 'pending_approval' && !execAp.locked && <Btn full busy={!!busy} disabled={left === 0} onClick={() => void approve()}><Icon n="key" />{busy === 'passkey' ? t('approving') : t('approve')}</Btn>}
    {!execAp.locked && busy !== 'submit' && <Btn full kind="ghost" disabled={!!busy} onClick={() => void closeExec()}>{prop.state === 'pending_approval' ? t('cancel') : t('swClose')}</Btn>}
  </div>;

  return (
    <div className="space-y-4">
      <PageTitle>{t('swap')}</PageTitle>

      {/* the centrepiece: what leaves, what arrives, one action */}
      <Card className="!p-2">
        {side(t('swYouPay'), from, 'from', <>
          <input className={`t-display mt-1 block min-h-12 w-full bg-transparent py-0.5 outline-none placeholder:text-mute/45 ${heroSize(amountText.length)}`} inputMode="decimal" placeholder="0" aria-label={t('amount')} value={amountText} onChange={(e) => setAmount(sanitizeAmountText(e.target.value))} autoComplete="off" />
          <AmountProblem text={amountText} />
          <div className="mt-0.5 flex min-h-6 items-center justify-between gap-3 text-[0.8125rem] text-mute"><span className="min-w-0">{chosen?.valuation.inUsd != null ? `≈ ${money(chosen.valuation.inUsd)}` : ' '}</span>
            {bal !== undefined && (bal === '?' ? <span className="shrink-0 text-warn">{t('qaBalUnknown')}</span> : <button className="-my-2.5 min-h-11 shrink-0 font-medium text-blue" onClick={() => setAmount(amountInputText(bal, locale))}>{t('available')}{sep}{trimAmt(bal, 6)}</button>)}</div></>)}
        <div className="relative z-[1] -my-[19px] flex justify-center"><button onClick={flip} aria-label={t('swFlip')} className="press grid h-11 w-11 place-items-center rounded-full border border-line bg-surface text-ink shadow-e2"><Icon n="swap" className="h-[18px] w-[18px] rotate-90" /></button></div>
        {side(t('swYouReceive'), to, 'to', <>
          <div className={`t-display mt-1 flex min-h-12 items-center break-all py-0.5 ${hero ? heroSize(trimAmt(hero.out, 8).length) : 'text-[2.5rem] text-mute/45'}`} aria-live="polite" data-testid="you-receive" data-source={hero ? hero.source : 'none'}>{hero ? trimAmt(hero.out, 8) : heroWait ? <span className="skel block h-9 w-40 !rounded-xl" style={{ background: 'color-mix(in srgb, var(--mute) 14%, transparent)' }} role="img" aria-label={t('swSearching')} /> : '0'}</div>
          <div className="mt-0.5 min-h-6 text-[0.8125rem] leading-6 text-mute">{hero ? <>{t('swMin')} <span className="font-semibold text-ink">{trimAmt(hero.min, 8)}</span>{hero.usd != null ? ` · ≈ ${money(hero.usd)}` : ''} · <span data-testid="you-receive-via">{hero.via}</span></> : ' '}</div>
          {bestOther && <div className="text-[0.8125rem] leading-snug text-mute" data-testid="best-comparison">{t('svHeroBestOther', { amount: trimAmt(bestOther.amountOutDisplay, 8), sym: bestOther.path[bestOther.path.length - 1]!.symbol, via: bestOther.providers.map(pname).join(' → ') })}</div>}</>)}
        <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-2.5 text-[0.8125rem]">
          <span className="min-w-0 leading-snug text-mute">{t('swSlippage')}</span>
          <div className="sw-slip w-[186px] shrink-0"><Seg label={t('swSlippage')} value={String(slip)} onChange={(v) => setSlip(Number(v))} options={[30, 50, 100].map((b) => [String(b), `${numFmt(b / 100, locale, 1)} %`] as const)} /></div>
        </div>
        {(action || (execErr && !exec && !isBridge)) && <div className="space-y-2.5 px-1 pb-1 pt-2.5">
          {execErr && !exec && !isBridge && <Notice tone="danger">{execErr}</Notice>}
          {action}
        </div>}
      </Card>

      {isBridge && amountOk && <Card>
        <div className="mb-3 flex items-center gap-3"><ProviderIcon provider="cctp" size={40} />
          <div className="min-w-0"><h2 className="text-[1.0625rem] font-semibold leading-snug tracking-[-0.015em]">{t('brTitle')}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-mute"><NetDot net={from!.network} size={18} />{from!.networkName}<Icon n="chev" className="h-3 w-3" /><NetDot net={to!.network} size={18} />{to!.networkName}</div></div></div>
        {brQ.isLoading && <div className="space-y-2" role="status" aria-label={t('swSearching')}><div className="skel h-3.5 w-4/5 !rounded-md" /><div className="skel h-[66px] !rounded-2xl" /><div className="skel h-[66px] !rounded-2xl" /><div className="skel h-[50px] !rounded-2xl" /></div>}
        {brQ.error ? <Notice tone="danger">{errText(t, brQ.error)}</Notice> : null}
        {brQ.data && <div className="space-y-3 text-[0.84375rem]">
          <p className="leading-snug text-mute">{t('brIntro', { from: brQ.data.fromName, to: brQ.data.toName, gas: brQ.data.destinationGas.symbol })}</p>
          <div className="space-y-2" role="radiogroup" aria-label={t('brSpeed')}>{brQ.data.options.map((o) => { const on = brSpeed === o.speed; return (
            <button key={o.speed} role="radio" aria-checked={on} disabled={!o.available} onClick={() => setSpeed(o.speed)} className={`press flex min-h-[66px] w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left ${on ? 'sw-opt-on border-primary bg-elev/60' : 'border-line'} ${o.available ? '' : 'opacity-50'}`}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'}`} aria-hidden="true">{on && <Icon n="check" className="h-3.5 w-3.5" />}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold leading-snug">{o.speed === 'fast' ? t('brOptFast', { fee: trimAmt(o.feeDisplay, 6) }) : t('brOptStandard')}</span>
                <span className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"><span className="text-[0.8125rem] text-mute">{o.available ? t('brOptTime', { time: bridgeDur(o.seconds) }) : t('brFastUnavailable')}</span>
                  <span className="t-num text-[1.0625rem]">{trimAmt(o.minReceiveDisplay, 6)} <span className="text-mute">USDC</span></span></span></span></button>); })}</div>
          {brQ.data.destinationGas.enough
            ? <p className="flex gap-2 leading-snug text-mute"><Icon n="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald" /><span className="min-w-0">{t('brDestGasLine', { net: brQ.data.toName, need: trimAmt(brQ.data.destinationGas.needDisplay, 8), have: trimAmt(brQ.data.destinationGas.balanceDisplay, 8), sym: brQ.data.destinationGas.symbol })}</span></p>
            : <Notice tone="warn">{t('brDestGasMissing', { sym: brQ.data.destinationGas.symbol, net: brQ.data.toName })} {t('brDestGasLine', { net: brQ.data.toName, need: trimAmt(brQ.data.destinationGas.needDisplay, 8), have: trimAmt(brQ.data.destinationGas.balanceDisplay, 8), sym: brQ.data.destinationGas.symbol })}</Notice>}
          {brSol?.role === 'source' && <p className="leading-snug text-mute" data-testid="sc-source">{t('scSrcIntro', { dep: trimAmt(brSol.depositDisplay, 9) })} {t('scSrcFee', { fee: trimAmt(brSol.networkFeeDisplay, 9) })}</p>}
          {brSol?.role === 'destination' && !ataMissing && <p className="leading-snug text-mute" data-testid="sc-destination">{t('scDstIntro', { acct: `${brSol.tokenAccount.slice(0, 6)}…${brSol.tokenAccount.slice(-6)}`, rent: trimAmt(brSol.nonceRentDisplay, 9) })}</p>}
          {brSol?.role === 'destination' && ataMissing && <Notice tone="warn"><span data-testid="sc-ata-missing"><b>{t('scAtaMissingTitle')}</b> {t('scAtaMissing', { rent: trimAmt(brSol.tokenAccountRentDisplay, 9) })}</span>
            <span className="mt-1 block break-all font-mono text-[0.6875rem] text-mute">{brSol.tokenAccount}</span>
            {ataMsg && <span className="mt-1 block">{ataMsg}</span>}{ataErr && <span className="mt-1 block text-danger">{ataErr}</span>}
            <ApprovalOutcomePanel ap={ataAp} quiet className="mt-2" />
            <div className="mt-2"><Btn full kind="soft" busy={ataBusy} disabled={ataAp.locked} onClick={() => void createAta()}><Icon n="key" className="h-4 w-4" />{t('scAtaCreate')}</Btn></div></Notice>}
          {execErr && !exec && <Notice tone="danger">{execErr}</Notice>}
          <Btn full busy={busy === 'prepare'} disabled={!brQ.data.destinationGas.enough || ataMissing} onClick={() => void prepare()}><Icon n="swap" className="h-4 w-4" />{t('brExecute', { net: brQ.data.toName })}</Btn>
        </div>}
      </Card>}

      {crossNet && from && to && <PlanCards from={from} to={to} amount={amount} slip={slip} routes={routes} money={money} pname={pname} onCount={setPlanCount} />}

      {noProviders && <Notice tone="warn">{t('swNoProviders')}</Notice>}

      {phase === 'idle' ? <EmptyState icon="swap" title={t('dzSwEmptyTitle')}>{t('dzSwEmptyBody')}</EmptyState>
        : <Section title={isBridge ? t('dzSwCompare') : t('dzSwRoutes')}>
          <div className="space-y-3">
            <Seg label={t('swMode')} value={mode} onChange={setMode} options={(['best_price', 'fastest', 'balanced'] as const).map((m) => [m, t(`sw_${m}` as Key)] as const)} />
            {phase === 'loading' && routes.length === 0 && <div className="space-y-3" role="status" aria-label={t('swSearching')}><RouteSkeleton /><RouteSkeleton /></div>}
            {phase === 'error' && (offline
              ? <ErrorState offline title={t('offline')} onRetry={() => setAgain((n) => n + 1)}>{t('dsOfflineBody')}</ErrorState>
              : <ErrorState title={t('swError')} onRetry={() => setAgain((n) => n + 1)}>{t('dzSwErrorBody')}</ErrorState>)}
            {phase === 'done' && routes.length === 0 && <Notice tone="warn">{reachable ? t('swNoLiquidity') : t('swNoRoute')}</Notice>}
            {shown.map(routeCard)}
            {folded.length > 0 && <Fold testid="routes-compare" className="px-1" summary={<span className="min-w-0 leading-snug">{isBridge ? t('qaSwOtherRoutes') : t('dzSwFoldTitle')} <span className="tag ml-1 align-[1px]" data-tone="mute">{folded.length}</span></span>}>
              <div className="-mx-1 space-y-3">{folded.map(routeCard)}</div></Fold>}
          </div>
        </Section>}

      {(phase === 'done' || provs.length > 0) && <p className="px-1 text-[0.78125rem] leading-snug text-mute">
        {took !== null && <>{(() => { const n = provs.length + new Set(routes.flatMap((r) => r.providers)).size; return n === 1 ? t('qaSwProviders1', { ms: took }) : t('swTook', { n, ms: took }); })()}{first !== null ? ` · ${t('swFirst', { ms: first })}` : ''}. </>}
        {provs.filter((p) => p.status !== 'no_route').map((p) => `${pname(p.provider)}${sep}${p.status === 'skipped' ? t('swSkipped') : ['unavailable', 'timeout', 'error', 'unsupported'].includes(p.status) ? t(`qaSwSt_${p.status}` as Key) : p.code ?? p.status}`).join(' · ')}
        {(provQ.data?.needsKey?.length ?? 0) > 0 && <span data-testid="needs-key"> {t('svNeedsKey', { list: provQ.data!.needsKey!.map(pname).join(', ') })}</span>}</p>}

      {/* what this screen does and does not execute — the same text as before, after the pair instead of above it */}
      <div className="flex gap-2.5 px-1 text-[0.78125rem] leading-snug text-mute" role="note"><Icon n="shield" className="mt-0.5 h-4 w-4 shrink-0" /><p className="min-w-0">{t('swIntro')}</p></div>

      {/* ── review sheets: the receipt the passkey signs. Same fields and values as ever, in full; nothing animated; they close only through their own buttons ── */}
      {review && !prop.bridge && !prop.xswap && <Sheet title={prop.state === 'pending_approval' ? t('swReview') : t('swTracking')} onClose={() => void closeExec()} dismissable={false} busy={!!busy} wide
        sub={reviewPill(testNotSent(prop) ? <Tag tone="warn" icon="warn">{t('qaSignedNotSent')}</Tag> : <StatePill state={prop.state} />)}>
        <div className="rounded-[20px] bg-elev/60 p-4">
          <ReviewAmount label={t('swYouPay')} sym={prop.symbol} net={prop.network}>{exactAmt(prop.amountDisplay)} <span className="text-mute">{prop.symbol}</span></ReviewAmount>
          <ReviewArrow />
          <ReviewAmount label={prop.swap.received ? t('swReceived') : t('swMinGuaranteed')} sym={prop.swap.toSymbol} net={prop.network}
            sub={!prop.swap.received && <>{t('swExpected')} {trimAmt(prop.swap.expectedOutDisplay, 10)} {prop.swap.toSymbol}</>}>{trimAmt(prop.swap.receivedDisplay ?? prop.swap.minOutDisplay, 10)} <span className="text-mute">{prop.swap.toSymbol}</span></ReviewAmount>
        </div>
        <dl className="receipt mt-2">
          <Fact k={t('network')}><span className="inline-flex items-center gap-1.5 align-middle"><NetDot net={prop.network} size={16} />{prop.networkName}</span> · {prop.swap.detail?.label ?? 'KyberSwap'}</Fact>
          {prop.swap.detail && <>
            <Fact k={t('swSolRoute')}>{(prop.swap.detail.venues as string[]).join(' + ')}</Fact>
            <Fact k={t('swSolNetworkFee')}>{trimAmt(prop.swap.detail.networkFeeDisplay, 9)} {prop.feeSymbol} <span className="font-normal text-mute">({t('swSolPriority')} {trimAmt(prop.swap.detail.priorityFeeDisplay, 9)})</span></Fact>
            {prop.swap.detail.createsAccount && <Fact k={t('swSolRent')}>{trimAmt(prop.swap.detail.rentDisplay, 9)} {prop.feeSymbol}</Fact>}
            {prop.state === 'pending_approval' && <Fact k={t('swSolSimulated')}>{trimAmt(prop.swap.detail.simulatedOutDisplay, 10)} {prop.swap.toSymbol}</Fact>}
          </>}
          <Fact k={t('feeMax')}>{prop.maxFeeDisplay ? `${trimAmt(prop.maxFeeDisplay, 9)} ${prop.feeSymbol}` : '—'}</Fact>
          {prop.swap.approvalState && <Fact k={t('swApproval')}>{t(`swAppr_${prop.swap.approvalState}` as Key)}</Fact>}
          {prop.quote && <Fact k={t('svQuoteFirmK')} testid="quote-vs-firm">{t('svQuoteFirm', { quoted: `${trimAmt(prop.quote.quotedOutDisplay, 8)} ${prop.swap.toSymbol}`, firm: `${trimAmt(prop.quote.firmOutDisplay, 8)} ${prop.swap.toSymbol}`, dev: `${prop.quote.deviationBps > 0 ? '+' : prop.quote.deviationBps < 0 ? '−' : ''}${numFmt(Math.abs(prop.quote.deviationBps) / 100, locale, 2, 2)} %` })}</Fact>}
          {prop.intentHash && <LongFact k={t('fingerprint')} mute>{prop.intentHash}</LongFact>}
          {prop.txid && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <LongFact k={t('txid')}>{prop.txid}</LongFact>}
        </dl>
        {prop.state === 'pending_approval' && <div className="mt-3 space-y-3">
          <Notice tone="ok">{prop.swap.detail ? t('swSolGuarantee') : t('swGuarantee')}</Notice>
          {prop.swap.detail?.createsAccount && <Notice tone="info">{t('swSolRentNote', { sym: prop.swap.toSymbol })}</Notice>}
          {prop.swap.detail && <Notice tone="info">{t('swSolExpiry')}</Notice>}
          {prop.swap.needsApproval && <Notice tone="info">{t('swNeedsApproval', { sym: prop.symbol })}</Notice>}
          <Notice tone="info">{t('irreversible')} {t('expiresIn')} {left} s.</Notice>
        </div>}
        {prop.error && ['failed', 'expired', 'rejected'].includes(prop.state) && <div className="mt-3"><Notice tone="danger">{propError(t, prop)}</Notice></div>}
        {testNotSent(prop) ? <div className="mt-3"><Notice tone="warn">{t('qaTestNotSent')}</Notice></div> : ['signed', 'broadcast', 'confirming'].includes(prop.state) && <p className="mt-3 flex items-center gap-2 text-[0.8125rem] text-mute"><Icon n="spin" className="h-4 w-4 shrink-0" />{t('broadcastNote')}</p>}
        {/* v11: the steps of this swap (approval when there is one, then the swap), each with its state and its transaction */}
        {prop.state !== 'pending_approval' && !testNotSent(prop) && <div className="mt-4"><ExecutionTimeline exec={prop.execution} /></div>}
        {execErr && <div className="mt-3"><Notice tone="danger">{execErr}</Notice></div>}
        {prop.explorer && !testNotSent(prop) && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <div className="mt-2"><ExplorerLink href={prop.explorer}>{t('viewExplorer')}</ExplorerLink></div>}
        {reviewActions}
      </Sheet>}

      {review && prop.bridge && <Sheet title={prop.state === 'pending_approval' ? t('brReview') : t('brTracking')} onClose={() => void closeExec()} dismissable={false} busy={!!busy} wide sub={reviewPill(testNotSent(prop) ? <Tag tone="warn" icon="warn">{t('qaSignedNotSent')}</Tag> : <BridgePill b={prop.bridge} />)}>
        <div className="rounded-[20px] bg-elev/60 p-4">
          <ReviewAmount sym={prop.symbol} net={prop.network} label={<span className="inline-flex flex-wrap items-center gap-1.5"><NetDot net={prop.network} size={16} />{prop.networkName} → <NetDot net={prop.bridge.toNetwork} size={16} />{prop.bridge.toNetworkName}</span>}>{exactAmt(prop.amountDisplay)} <span className="text-mute">{prop.symbol}</span></ReviewAmount>
        </div>
        <dl className="receipt mt-2">
          <BridgeFacts b={prop.bridge} symbol={prop.symbol} />
          <Fact k={`${t('feeMax')} · ${prop.networkName}`}>{prop.maxFeeDisplay ? `${trimAmt(prop.maxFeeDisplay, 9)} ${prop.feeSymbol}` : '—'}</Fact>
          {prop.intentHash && <LongFact k={t('fingerprint')} mute>{prop.intentHash}</LongFact>}
          {prop.txid && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <LongFact k={t('txid')}>{prop.txid}</LongFact>}
        </dl>
        {prop.state === 'pending_approval' && <div className="mt-3 space-y-3">
          <Notice tone="ok">{t('brGuarantee', { from: prop.networkName, to: prop.bridge.toNetworkName })}{prop.bridge.sol ? ` ${prop.bridge.sol.role === 'source' ? t('scReviewSrc', { to: prop.bridge.toNetworkName }) : t('scReviewDst')}` : ''}</Notice>
          {prop.bridge.needsApproval && <Notice tone="info">{t('qaBrNeedsApproval', { sym: prop.symbol })}</Notice>}
          <Notice tone="info">{t('brIrreversible', { from: prop.networkName, to: prop.bridge.toNetworkName })} {t('expiresIn')} {left} s.</Notice>
        </div>}
        {prop.error && ['failed', 'expired', 'rejected'].includes(prop.state) && <div className="mt-3"><Notice tone="danger">{propError(t, prop)}</Notice></div>}
        {testNotSent(prop) && <div className="mt-3"><Notice tone="warn">{t('qaTestNotSent')}</Notice></div>}
        {prop.state !== 'pending_approval' && !testNotSent(prop) && <div className="mt-4"><BridgeProgress id={prop.id} b={prop.bridge} fromNetwork={prop.network} onUpdate={(p) => { setExec({ ...exec, proposal: p }); void qc.invalidateQueries({ queryKey: ['proposal', p.id] }); }} /></div>}
        {execErr && <div className="mt-3"><Notice tone="danger">{execErr}</Notice></div>}
        {prop.explorer && !testNotSent(prop) && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <div className="mt-2"><ExplorerLink href={prop.explorer}>{t('viewExplorer')}</ExplorerLink></div>}
        {reviewActions}
      </Sheet>}

      {review && prop.xswap && <Sheet title={prop.state === 'pending_approval' ? t('xsReview') : t('xsTracking')} onClose={() => void closeExec()} dismissable={false} busy={!!busy} wide sub={reviewPill(testNotSent(prop) ? <Tag tone="warn" icon="warn">{t('qaSignedNotSent')}</Tag> : <XswapPill x={prop.xswap} />)}>
        <XswapSheet prop={prop} left={left} onUpdate={(p) => { setExec({ ...exec, proposal: p }); void qc.invalidateQueries({ queryKey: ['proposal', p.id] }); }} />
        {execErr && <div className="mt-3"><Notice tone="danger">{execErr}</Notice></div>}
        {prop.explorer && !testNotSent(prop) && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <div className="mt-2"><ExplorerLink href={prop.explorer}>{t('viewExplorer')}</ExplorerLink></div>}
        {reviewActions}
      </Sheet>}

      <Picker open={pick !== null} onClose={() => setPick(null)} assets={assets} balances={balances} exclude={pick === 'from' ? toKey : fromKey} onPick={(a) => { if (pick === 'from') setFromKey(a.key); else setToKey(a.key); }} />
    </div>
  );
}
