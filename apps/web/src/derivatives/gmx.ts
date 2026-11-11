/**
 * GMX v2 trading (v8): typed client of the routes under /derivatives/gmx — exactly the section "GMX v2 trading (v8)" of
 * docs/v4/API-LIVE-NOTES.md — and the pure rules of the screens. GMX has no venue account: the account is the wallet's own
 * Arbitrum address, and an order is a transaction of the wallet that a GMX keeper executes (or cancels) later. The ONE place
 * that decides which words describe an operation is `gmxOpWords`: success exists for `executed` (and for a mined cancel) only;
 * `created` is never shown as executed.
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError, get, post } from '../api';
import { D, dec, parseInput, type DecStr } from './dec';
import type { Ack, PasskeyOptions } from './live';

export type GmxBlocker = 'gmx_setting_off' | 'mainnet_setting_off' | 'not_authorized' | 'authorization_expired' | 'authorization_revoked' | 'contracts_changed' | 'signer_halted' | 'chain_unreadable' | 'wallet_unreadable';
export type GmxSide = 'long' | 'short';
export type GmxOpState = 'pending_approval' | 'signed' | 'sent' | 'created' | 'executed' | 'cancelled' | 'frozen' | 'done' | 'failed' | 'expired' | 'withdrawn' | 'unknown';
export interface GmxPolicy { allowedMarkets: string[]; maxLeverage: number; maxOrderSizeUsd: DecStr; maxOrdersPerDay: number; maxPriceDeviationBps: number; maxExecutionFeeWei?: string }
export interface GmxMarket { market: string; name: string; instrument: string; base: string; indexDecimals: number; collateral: { token: string; symbol: string; decimals: number }[]; allowed: boolean; mark: DecStr | null; oracleMin: DecStr | null; oracleMax: DecStr | null }
export interface GmxPosition { key: string; market: string; marketName: string; instrument: string; side: GmxSide; collateralToken: string; collateralSymbol: string; sizeUsd: DecStr; sizeTokens: DecStr; collateral: DecStr; entryPrice: DecStr;
  markPrice: DecStr | null; /** estimate at the mark, before fees */ pnlUsd: DecStr | null; leverage: DecStr | null; /** estimate */ liquidationPrice: DecStr | null; /** unix s */ increasedAt: number; source: 'chain';
  /** cross-check with GMX's own API */ venueApi: { agrees: boolean | null; detail: string | null } }
export interface GmxPendingOrder { key: string; market: string; marketName: string; orderType: string; side: GmxSide; sizeUsd: DecStr; collateral: DecStr; acceptablePrice: DecStr; executionFeeEth: DecStr; /** unix s */ updatedAt: number; /** unix s */ cancellableAt: number;
  frozen: boolean; /** null = not created by this wallet's engine */ opId: string | null }
export interface GmxEstimate { source: 'estimate'; referencePrice: DecStr; oracleMin: DecStr; oracleMax: DecStr; acceptablePrice: DecStr; slippageBps: number; sizeUsd: DecStr; sizeTokens: DecStr; collateral: DecStr | null; leverage: DecStr | null;
  positionFee: { usd: DecStr; bps: DecStr | number; balanceImproved: boolean };
  priceImpact: { /** negative = cost */ usd: DecStr; uncertaintyUsd: DecStr; settledAt: 'close'; capped: boolean; note: string };
  executionFee: { eth: DecStr; usd: DecStr | null; sentWei: string; note: string };
  gas: { maxEth: DecStr; expectedEth: DecStr; usd: DecStr | null }; approval: boolean;
  /** fraction of size per hour; positive = the position PAYS */ funding: { perHour: DecStr; usdPerDay: DecStr }; borrow: { perHour: DecStr; usdPerDay: DecStr };
  liquidationPrice: DecStr | null; liquidationNote: string; totalAtEntryUsd: DecStr | null; notes: string[]; ts: number }
export interface GmxOutcome { event: 'OrderExecuted' | 'OrderCancelled' | 'OrderFrozen'; txid: string; explorer: string; executionPrice: DecStr | null; sizeUsd: DecStr | null; positionFeeUsd: DecStr | null; priceImpactUsd: DecStr | null; pnlUsd: DecStr | null;
  collateralOut: DecStr | null; executionFeeRefundEth: DecStr | null; reason: string | null; reasonCode: string | null; cancelledBy: 'keeper' | 'owner' | null; collateralReturned: boolean | null }
export interface GmxOperation { id: string; kind: 'increase' | 'decrease' | 'cancel'; state: GmxOpState; final: boolean; market: string | null; marketName: string | null; side: GmxSide | null; collateral: DecStr | null; collateralSymbol: string | null;
  sizeUsd: DecStr | null; acceptablePrice: DecStr | null; slippageBps: number | null; leverage: DecStr | null; executionFeeEth: DecStr; maxFeeEth: DecStr; needsApproval: boolean; orderKey: string | null; targetOpId: string | null;
  /** intent hash = what the passkey signs */ hash: string | null; proposalId: string; txid: string | null; explorer: string | null; approvalTxid: string | null;
  createdAt: number; expiresAt: number | null; sentAt: number | null; orderCreatedAt: number | null; doneAt: number | null; checkedAt: number | null;
  /** unix ms: when the owner may cancel a still-pending market order */ cancellableAt: number | null; /** created, no keeper after 10 min */ overdue: boolean; estimate: GmxEstimate | null; outcome: GmxOutcome | null; error: string | null }
export interface GmxStatus { venue: 'gmx'; network: 'arbitrum'; chainId: number; settings: { liveMainnet: boolean; gmxLive: boolean }; tradable: boolean; blockers: GmxBlocker[]; blockerText: Partial<Record<GmxBlocker, string>>;
  pins: { id: string; reviewedAt: string; /** null = could not be checked */ ok: boolean | null; checkedAt: number | null; problems: string[]; contracts: { name: string; address: string; explorer: string }[] };
  account: { address: string; explorer: string } | null;
  wallet: { usdc: DecStr; eth: DecStr; weth: DecStr; limits: { perTransfer: DecStr; perDay: DecStr; spentToday: DecStr; maxNow: DecStr }; feeCeilingEth: DecStr } | null; walletError: string | null;
  authorization: null | { id: string; state: 'active' | 'expired' | 'revoked' | 'stale'; policy: GmxPolicy; createdAt: number; /** unix s */ expiresAt: number; today: { increases: number; reduces: number } };
  markets: GmxMarket[]; positions: GmxPosition[]; positionsSource: 'chain'; positionsError: string | null; pendingOrders: GmxPendingOrder[]; operations: GmxOperation[];
  facts: { requestExpirationSec: number; executionGas: string | null; twoStep: true }; ts: number }
export interface GmxOrderBody { market: string; side: GmxSide; action: 'increase' | 'decrease'; collateral?: DecStr; leverage?: DecStr; sizeUsd?: DecStr; slippageBps?: number }
export interface GmxPreview { order: { market: string; marketName: string; side: GmxSide; action: 'increase' | 'decrease'; collateral: DecStr | null; sizeUsd: DecStr; acceptablePrice: DecStr; slippageBps: number; leverage: DecStr | null };
  estimate: GmxEstimate; risk: { ok: true } | { ok: false; code: string; reason: string }; blockers: GmxBlocker[]; signerWould: string | null }
export interface GmxField { label: string; value: string }
export interface GmxPrepared { operation: GmxOperation; intent: unknown; estimate: GmxEstimate | null; /** exactly what the passkey signs */ fields: GmxField[]; /** what the signer fixes itself */ fixed: GmxField[]; options: PasskeyOptions }
export interface GmxAuthBody { allowedMarkets: string[]; maxLeverage: number; maxOrderSizeUsd: DecStr; maxOrdersPerDay: number; maxPriceDeviationBps: number; days: number; locale: 'fr' | 'en' }
/** `authorization` is sent back as received at approval; only the fields read here are assumed (the contract names the type without its shape) */
export interface GmxAuthPrepared { authorization: { policy?: Partial<GmxPolicy>; expiresAt?: number } & Record<string, unknown>; hash: string; ack: Ack; options: PasskeyOptions; maxExecutionFeeEth: DecStr }

const G = '/derivatives/gmx';
export const gapi = {
  status: (locale: string) => get<GmxStatus>(`${G}/status?locale=${locale === 'en' ? 'en' : 'fr'}`),
  prepareAuthorization: (body: GmxAuthBody) => post<GmxAuthPrepared>(`${G}/authorization/prepare`, body),
  approveAuthorization: (authorization: unknown, assertion: unknown) => post<GmxStatus>(`${G}/authorization/approve`, { authorization, assertion }),
  revoke: () => post<GmxStatus>(`${G}/authorization/revoke`, {}),
  preview: (body: GmxOrderBody) => post<GmxPreview>(`${G}/orders/preview`, body),
  order: (body: GmxOrderBody, key: string) => post<GmxPrepared>(`${G}/orders`, body, { 'idempotency-key': key }),
  close: (body: { market: string; side: GmxSide; fraction?: DecStr; slippageBps?: number }, key: string) => post<GmxPrepared>(`${G}/positions/close`, body, { 'idempotency-key': key }),
  cancel: (opId: string) => post<GmxPrepared>(`${G}/orders/${encodeURIComponent(opId)}/cancel`, {}),
  approve: async (opId: string, assertion: unknown): Promise<GmxOperation> => (await post(`${G}/operations/${encodeURIComponent(opId)}/approve`, { assertion })).operation,
  withdraw: async (opId: string): Promise<GmxOperation> => (await post(`${G}/operations/${encodeURIComponent(opId)}/withdraw`, {})).operation,
  operation: async (opId: string): Promise<GmxOperation> => (await get(`${G}/operations/${encodeURIComponent(opId)}`)).operation,
};

export const GMX_STATUS_KEY = ['deriv', 'gmx', 'status'] as const;
/** money has left the wallet (or is about to) and the chain has not said the last word */
export const gmxInFlight = (o: Pick<GmxOperation, 'state' | 'final'>): boolean => !o.final && o.state !== 'pending_approval';
/** `GET /status` works with every lock closed; read every few seconds while something is in flight. A backend without the routes simply has no data. */
export function useGmx(locale: string, enabled = true) {
  return useQuery({ queryKey: [...GMX_STATUS_KEY, locale], queryFn: () => gapi.status(locale), enabled, retry: 0,
    refetchInterval: (q) => (q.state.data && (q.state.data.operations.some(gmxInFlight) || q.state.data.pendingOrders.length > 0) ? 3000 : 15_000) });
}
export const gmxMarketOf = (s: GmxStatus | undefined, instrument: string): GmxMarket | null => s?.markets.find((m) => m.instrument === instrument) ?? null;

/** the blocker to explain first: a server setting before the authorization, the authorization before the rest */
const ORDER: GmxBlocker[] = ['gmx_setting_off', 'mainnet_setting_off', 'contracts_changed', 'signer_halted', 'chain_unreadable', 'wallet_unreadable', 'authorization_revoked', 'authorization_expired', 'not_authorized'];
export const sortBlockers = (b: GmxBlocker[]): GmxBlocker[] => [...b].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
export const SETTING_OF: Partial<Record<GmxBlocker, string>> = { gmx_setting_off: 'SPW_DERIV_GMX_LIVE', mainnet_setting_off: 'SPW_DERIV_LIVE_MAINNET' };
/** the owner can lift this blocker himself with the authorization flow (and nothing else stands in the way of it) */
export const needsAuthorization = (s: GmxStatus): boolean => s.blockers.length > 0 && s.blockers.every((b) => b === 'not_authorized' || b === 'authorization_expired' || b === 'authorization_revoked');

export interface GmxOpWords { /** i18n key of the sentence that says where the operation is */ key: string; tone: 'ok' | 'info' | 'warn' | 'danger' | 'mute'; /** 0-based step reached of signed → on chain → executed */ step: number }
const WORDS: Record<string, GmxOpWords> = {
  pending_approval: { key: 'gxOp_pending_approval', tone: 'info', step: 0 }, signed: { key: 'gxOp_signed', tone: 'info', step: 0 }, sent: { key: 'gxOp_sent', tone: 'info', step: 1 },
  created: { key: 'gxOp_created', tone: 'warn', step: 2 }, executed: { key: 'gxOp_executed', tone: 'ok', step: 3 }, cancelled: { key: 'gxOp_cancelled', tone: 'warn', step: 2 }, frozen: { key: 'gxOp_frozen', tone: 'warn', step: 2 },
  done: { key: 'gxOp_done', tone: 'ok', step: 3 }, failed: { key: 'gxOp_failed', tone: 'danger', step: 0 }, expired: { key: 'gxOp_expired', tone: 'mute', step: 0 }, withdrawn: { key: 'gxOp_withdrawn', tone: 'mute', step: 0 },
  unknown: { key: 'gxOp_unknown', tone: 'warn', step: 1 },
};
/** The words for an operation. An unknown state is never good news; a `created` order is waiting, whatever else is known. */
export function gmxOpWords(op: Pick<GmxOperation, 'kind' | 'state' | 'overdue' | 'outcome'>): GmxOpWords {
  const w = WORDS[op.state] ?? { key: 'gxOp_other', tone: 'warn' as const, step: 0 };
  if (op.state === 'created' && op.overdue) return { ...w, key: 'gxOp_overdue' };
  if (op.state === 'cancelled') return { ...w, key: op.outcome?.cancelledBy === 'owner' ? 'gxOp_cancelled_owner' : op.outcome?.cancelledBy === 'keeper' ? 'gxOp_cancelled_keeper' : 'gxOp_cancelled' };
  if (op.kind === 'cancel' && (op.state === 'signed' || op.state === 'sent')) return { ...w, key: 'gxOp_cancel_sent' };
  return w;
}
export const gmxOpDone = (op: Pick<GmxOperation, 'state'>): boolean => op.state === 'executed' || op.state === 'done';

/** the codes the GMX routes answer with, each with its sentence (`gxE_<code>`) */
export const GMX_CODES: ReadonlySet<string> = new Set(['gmx_disabled', 'mainnet_disabled', 'not_authorized', 'contract_changed', 'policy', 'venue_policy', 'simulation_failed', 'pending_tx', 'not_yet_cancellable', 'bad_state', 'expired', 'chain_unreadable']);
export interface GmxErr { /** i18n key */ key: string; code: string; status: number; /** the server's own words */ detail: string; /** not a GMX code: shown by the live notice (passkey, transport…) */ generic: boolean }
export function gmxError(e: unknown): GmxErr {
  if (!(e instanceof ApiError)) return { key: 'other', code: String((e as { name?: string })?.name ?? 'error'), status: 0, detail: '', generic: true };
  const code = e.code, detail = e.message && e.message !== 'error' && e.message !== code ? e.message : '';
  if (GMX_CODES.has(code)) return { key: `gxE_${code}`, code, status: e.status, detail, generic: false };
  if (e.status === 422 && code.startsWith('risk_')) return { key: 'gxE_risk', code, status: e.status, detail, generic: false };
  if (e.status === 422 && code.startsWith('signer_')) return { key: 'gxE_signer', code, status: e.status, detail, generic: false };
  return { key: 'other', code, status: e.status, detail, generic: true };
}

// ---------------------------------------------------------------- the order form
export interface GmxForm { side: GmxSide; collateral: string; mode: 'leverage' | 'size'; leverage: string; sizeUsd: string; slippageBps: string }
export type GmxFormProblem = 'gxErrCollateral' | 'gxErrLeverage' | 'gxErrSize' | 'gxErrSlippage' | 'gxErrAboveWallet' | 'gxErrAboveLimit' | 'gxErrAbovePolicy' | 'gxErrLevPolicy';
const usdcIn = (raw: string): DecStr | null => { const x = parseInput(raw); return x !== null && /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(x) && D.isPos(D.from(x)) ? x : null; };
const lt = (a: DecStr, b: DecStr) => D.lt(D.from(a), D.from(b));
/** the body of preview / order from the form, or what stops it — from the status alone (the server, the risk engine and the signer check again) */
export function buildGmx(f: GmxForm, market: string, s: Pick<GmxStatus, 'wallet' | 'authorization'>): { body: GmxOrderBody | null; problem: GmxFormProblem | null; /** size ÷ collateral, for display */ leverage: DecStr | null; sizeUsd: DecStr | null } {
  const none = { body: null, leverage: null, sizeUsd: null };
  if (f.collateral.trim() === '') return { ...none, problem: null };
  const collateral = usdcIn(f.collateral);
  if (!collateral) return { ...none, problem: 'gxErrCollateral' };
  const bps = Number(f.slippageBps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 500) return { ...none, problem: 'gxErrSlippage' };
  let leverage: DecStr, sizeUsd: DecStr;
  if (f.mode === 'leverage') {
    const l = parseInput(f.leverage);
    if (l === null || !/^\d{1,2}(\.\d)?$/.test(l) || lt(l, '1')) return { ...none, problem: 'gxErrLeverage' };
    leverage = l; sizeUsd = D.str(D.div(D.mul(D.from(collateral), D.from(l)), D.one, 2, 'down'));
  } else {
    const z = parseInput(f.sizeUsd);
    if (f.sizeUsd.trim() === '') return { ...none, problem: null };
    if (z === null || !/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(z) || lt(z, collateral)) return { ...none, problem: 'gxErrSize' };
    sizeUsd = z; leverage = D.str(D.div(D.from(z), D.from(collateral), 2, 'half_even'));
  }
  const out = { leverage, sizeUsd };
  if (s.wallet && lt(s.wallet.usdc, collateral)) return { body: null, ...out, problem: 'gxErrAboveWallet' };
  if (s.wallet && lt(s.wallet.limits.maxNow, collateral)) return { body: null, ...out, problem: 'gxErrAboveLimit' };
  const p = s.authorization?.policy;
  if (p && D.gt(D.from(leverage), D.from(String(p.maxLeverage)))) return { body: null, ...out, problem: 'gxErrLevPolicy' };
  if (p && dec(p.maxOrderSizeUsd) && lt(p.maxOrderSizeUsd, sizeUsd)) return { body: null, ...out, problem: 'gxErrAbovePolicy' };
  return { body: { market, side: f.side, action: 'increase', collateral, ...(f.mode === 'leverage' ? { leverage } : { sizeUsd }), slippageBps: bps }, problem: null, ...out };
}

// ---------------------------------------------------------------- the authorization form
export interface GmxAuthForm { markets: string[]; maxLeverage: string; maxOrderSizeUsd: string; maxOrdersPerDay: string; bandBps: string; days: string }
export type GmxAuthProblem = 'markets' | 'leverage' | 'order' | 'ordersPerDay' | 'band' | 'days';
const int = (raw: string, min: number, max: number): number | null => { const n = Number(raw.trim()); return /^\d+$/.test(raw.trim()) && n >= min && n <= max ? n : null; };
/** bounds of the contract: leverage 1–20, orders per day 1–100, price band 10–1000 bps, 1–90 days */
export function gmxAuthFromForm(f: GmxAuthForm, locale: string): { ok: true; body: GmxAuthBody } | { ok: false; problem: GmxAuthProblem } {
  if (!f.markets.length) return { ok: false, problem: 'markets' };
  const lev = int(f.maxLeverage, 1, 20), perDay = int(f.maxOrdersPerDay, 1, 100), band = int(f.bandBps, 10, 1000), days = int(f.days, 1, 90), size = parseInput(f.maxOrderSizeUsd);
  if (lev === null) return { ok: false, problem: 'leverage' };
  if (size === null || !/^[1-9]\d{0,8}(\.\d{1,2})?$/.test(size)) return { ok: false, problem: 'order' };
  if (perDay === null) return { ok: false, problem: 'ordersPerDay' };
  if (band === null) return { ok: false, problem: 'band' };
  if (days === null) return { ok: false, problem: 'days' };
  return { ok: true, body: { allowedMarkets: f.markets, maxLeverage: lev, maxOrderSizeUsd: size, maxOrdersPerDay: perDay, maxPriceDeviationBps: band, days, locale: locale === 'en' ? 'en' : 'fr' } };
}

// ---------------------------------------------------------------- hand-over from the router (a pre-filled form, nothing more)
export interface GmxPrefill { instrument: string; side: GmxSide; /** USDC */ collateral: string; sizeUsd: string; leverage: string }
const PKEY = 'spw-gmx-prefill';
export function setGmxPrefill(p: GmxPrefill): void { try { sessionStorage.setItem(PKEY, JSON.stringify(p)); } catch { /* private mode: the panel opens empty */ } }
const readPrefill = (): GmxPrefill | null => { try { const s = sessionStorage.getItem(PKEY); return s ? (JSON.parse(s) as GmxPrefill) : null; } catch { return null; } };
export function peekGmxPrefill(instrument: string): GmxPrefill | null { const p = readPrefill(); return p && p.instrument === instrument ? p : null; }
export function clearGmxPrefill(instrument: string): void { if (readPrefill()?.instrument === instrument) { try { sessionStorage.removeItem(PKEY); } catch { /* nothing to clear */ } } }
