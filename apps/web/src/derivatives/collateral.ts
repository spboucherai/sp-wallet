/**
 * Collateral of a venue account: typed client of the routes under /derivatives/live/accounts/:id/collateral/… (shapes:
 * docs/v4/API-LIVE-NOTES.md, "Collateral") and the pure rules of the two sheets — what may be typed, what the review must
 * equal before the passkey is asked, and the ONE place that decides which words describe an operation. A deposit is "done"
 * only in the state `credited` (the venue's ledger shows it); a withdrawal only in `completed` (the wallet saw the USDC).
 */
import { get, post } from '../api';
import { D, dec, parseInput, type DecStr } from './dec';
import type { LiveNetwork, PasskeyOptions } from './live';

export interface VenueBalance { abstraction: string | null; equity: DecStr | null; withdrawable: DecStr | null; spotUsdc: DecStr | null; total: DecStr | null; error: string | null; ts: number }
export interface CollateralOp {
  id: string; kind: 'deposit' | 'withdraw'; state: string; final: boolean; venueNetwork: LiveNetwork; amount: DecStr; asset: string; fee: DecStr | null; expectedReceive: DecStr | null;
  chainNetwork: string | null; chainNetworkName: string | null; bridge: string | null; txid: string | null; explorer: string | null; hash: string | null; proposalState: string | null; confirmations: number | null;
  createdAt: number; expiresAt: number | null; sentAt: number | null; venueAt: number | null; doneAt: number | null; expectedSeconds: number; overdue: boolean; check: string[];
  balanceBefore: VenueBalance | null; balanceAfter: VenueBalance | null; ledger: { time: number; hash: string; type: string; usdc: string | null; fee: string | null } | null;
  arrival: { txid: string; amount: string; seenAt: number } | null; error: string | null; attempts: number; arrivalTracked: boolean | null;
}
export interface CollateralStatus {
  account: string; accountId: string; venue: string; network: LiveNetwork; mainnetEnabled: boolean; venueBalance: VenueBalance;
  route: { id: string; network: string; networkName: string; bridge: string; bridgeExplorer: string; asset: string; token: string; venueMinimum: DecStr; minimum: DecStr; expectedSeconds: number; credits: 'sender'; venueFee: DecStr; legacy: boolean; pinnedAt: string; codeSha256: string } | null;
  withdrawal: { fee: DecStr; expectedSeconds: number; destination: string; payoutNetworkName: string; arrivalTracked: boolean; available: DecStr | null };
  wallet: { address: string; network: string; networkName: string; usdc: DecStr; gas: DecStr; gasSymbol: string; limits: { perTransfer: DecStr; perDay: DecStr; spentToday: DecStr; maxNow: DecStr }; elsewhere: { network: string; name: string; usdc: DecStr }[] } | null;
  walletError: string | null;
  deposit: { available: boolean; reason: string | null; bridgeFrom: { network: string; name: string; usdc: DecStr }[] }; withdraw: { available: boolean; reason: string | null };
  operations: CollateralOp[]; ts: number;
}
export interface DepositPrepared {
  operation: CollateralOp; options: PasskeyOptions; venueBalance: VenueBalance;
  intent: { network: string; chainRef: string; asset: string; symbol: string; decimals: number; amount: string; from: string; to: string; expiresAt: number; venueDeposit?: { venue: string; venueNetwork: string; route: string; bridge: string; minAmount: string } };
  route: { network: string; networkName: string; bridge: string; minimum: DecStr; venueMinimum: DecStr; expectedSeconds: number }; fee: { estimate: DecStr; max: DecStr; symbol: string };
  liveness: { ok: boolean; checkedAt: number; checked: number; credited: number; detail: string };
}
export interface WithdrawPrepared {
  operation: CollateralOp; options: PasskeyOptions; venueBalance: VenueBalance; hash: string; receive: DecStr;
  withdrawal: { network: LiveNetwork; account: string; destination: string; amount: DecStr; fee: DecStr; time: number; expiresAt: number };
  whatIsSigned: { byMainKey: string; byPasskey: string; action: { type: string; hyperliquidChain: string; destination: string; amount: string; time: number } };
}

const C = (id: string) => `/derivatives/live/accounts/${encodeURIComponent(id)}/collateral`;
export const capi = {
  status: (id: string) => get<CollateralStatus>(`${C(id)}/status`),
  operation: async (id: string, op: string): Promise<CollateralOp> => (await get(`${C(id)}/operations/${op}`)).operation,
  prepareDeposit: (id: string, amount: DecStr) => post<DepositPrepared>(`${C(id)}/deposit/prepare`, { amount }),
  approveDeposit: async (id: string, op: string, assertion: unknown): Promise<CollateralOp> => (await post(`${C(id)}/deposit/${op}/approve`, { assertion })).operation,
  prepareWithdraw: (id: string, amount: DecStr) => post<WithdrawPrepared>(`${C(id)}/withdraw/prepare`, { amount }),
  approveWithdraw: async (id: string, op: string, assertion: unknown): Promise<CollateralOp> => (await post(`${C(id)}/withdraw/${op}/approve`, { assertion })).operation,
  cancel: async (id: string, op: string): Promise<CollateralOp> => (await post(`${C(id)}/operations/${op}/cancel`)).operation,
};

const lt = (a: DecStr, b: DecStr) => D.lt(D.from(a), D.from(b));
/** a typed USDC amount as a decimal string with at most 6 decimals, or null */
export function usdcInput(raw: string): DecStr | null {
  const x = parseInput(raw);
  return x !== null && /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(x) && D.isPos(D.from(x)) ? x : null;
}

export type DepositProblem = 'hlcErrAmount' | 'hlcErrBelowMin' | 'hlcErrAboveBalance' | 'hlcErrAboveLimit' | 'hlcErrAboveDay';
/** what stops a deposit of this amount, from the status alone (the server and the signer check again) */
export function depositProblem(raw: string, s: Pick<CollateralStatus, 'route' | 'wallet'>): { amount: DecStr | null; problem: DepositProblem | null } {
  if (raw.trim() === '') return { amount: null, problem: null };
  const amount = usdcInput(raw);
  if (!amount || !s.route || !s.wallet) return { amount: null, problem: 'hlcErrAmount' };
  // below the minimum the venue credits nothing and the money is lost: this is the first thing said
  if (lt(amount, s.route.minimum)) return { amount: null, problem: 'hlcErrBelowMin' };
  if (lt(s.wallet.usdc, amount)) return { amount: null, problem: 'hlcErrAboveBalance' };
  if (lt(s.wallet.limits.perTransfer, amount)) return { amount: null, problem: 'hlcErrAboveLimit' };
  if (lt(D.str(D.sub(D.from(s.wallet.limits.perDay), D.from(s.wallet.limits.spentToday))), amount)) return { amount: null, problem: 'hlcErrAboveDay' };
  return { amount, problem: null };
}
export type WithdrawProblem = 'hlcErrAmount' | 'hlcErrBelowFee' | 'hlcErrAboveVenue';
export function withdrawProblem(raw: string, s: Pick<CollateralStatus, 'withdrawal'>): { amount: DecStr | null; receive: DecStr | null; problem: WithdrawProblem | null } {
  if (raw.trim() === '') return { amount: null, receive: null, problem: null };
  const amount = usdcInput(raw);
  if (!amount) return { amount: null, receive: null, problem: 'hlcErrAmount' };
  if (!D.gt(D.from(amount), D.from(s.withdrawal.fee))) return { amount: null, receive: null, problem: 'hlcErrBelowFee' };
  if (s.withdrawal.available !== null && dec(s.withdrawal.available) && lt(s.withdrawal.available, amount)) return { amount: null, receive: null, problem: 'hlcErrAboveVenue' };
  return { amount, receive: D.str(D.sub(D.from(amount), D.from(s.withdrawal.fee))), problem: null };
}

const units = (x: DecStr): string => { const [w, f = ''] = x.split('.'); return (BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, '0') || '0')).toString(); };
/**
 * What is on the review sheet must be what the passkey commits to. Returns null, or what differs: the sheet then refuses to
 * ask for the passkey. (The signer checks the same things from its own pinned table; this is the screen's own reading.)
 */
export function depositIntegrity(p: DepositPrepared, s: CollateralStatus, amount: DecStr): 'amount' | 'bridge' | 'account' | 'asset' | 'minimum' | null {
  const i = p.intent, r = s.route;
  if (!r || !s.wallet) return 'bridge';
  if (i.amount !== units(amount) || p.operation.amount !== D.str(D.from(amount))) return 'amount';
  if (i.to !== r.bridge || i.venueDeposit?.bridge !== r.bridge || p.route.bridge !== r.bridge || i.network !== r.network || i.venueDeposit?.venueNetwork !== s.network || i.venueDeposit?.venue !== 'hyperliquid') return 'bridge';
  if (i.from !== s.wallet.address || i.from.toLowerCase() !== s.account.toLowerCase()) return 'account';   // the venue credits the sender: it must be the venue account itself
  if (i.asset !== r.token || i.symbol !== 'USDC' || i.decimals !== 6) return 'asset';
  if (i.venueDeposit.minAmount !== units(r.minimum) || lt(amount, r.minimum)) return 'minimum';
  return null;
}
export function withdrawIntegrity(p: WithdrawPrepared, s: CollateralStatus, amount: DecStr): 'amount' | 'destination' | 'fee' | 'network' | null {
  const w = p.withdrawal, a = p.whatIsSigned.action, me = s.account.toLowerCase();
  if (D.str(D.from(w.amount)) !== D.str(D.from(amount)) || a.amount !== w.amount || p.operation.amount !== D.str(D.from(amount))) return 'amount';
  if (w.destination !== me || w.account !== me || a.destination !== me || a.type !== 'withdraw3') return 'destination';   // only ever the wallet's own address
  if (D.str(D.from(w.fee)) !== D.str(D.from(s.withdrawal.fee)) || p.receive !== D.str(D.sub(D.from(w.amount), D.from(w.fee)))) return 'fee';
  if (w.network !== s.network || a.hyperliquidChain !== (s.network === 'mainnet' ? 'Mainnet' : 'Testnet') || a.time !== w.time) return 'network';
  return null;
}

export interface OpWords { /** i18n key of the one sentence that says where the operation is */ key: string; tone: 'ok' | 'info' | 'warn' | 'danger'; /** money has left and has not been seen on the other side yet */ waiting: boolean; /** 0-based step reached, of the 4 shown */ step: number }
const DEPOSIT: Record<string, OpWords> = {
  pending_approval: { key: 'hlcOp_dep_pending_approval', tone: 'info', waiting: false, step: 0 }, signed: { key: 'hlcOp_dep_signed', tone: 'info', waiting: true, step: 1 },
  sent: { key: 'hlcOp_dep_sent', tone: 'info', waiting: true, step: 1 }, awaiting_credit: { key: 'hlcOp_dep_awaiting_credit', tone: 'info', waiting: true, step: 2 },
  credited: { key: 'hlcOp_dep_credited', tone: 'ok', waiting: false, step: 3 }, failed: { key: 'hlcOp_dep_failed', tone: 'danger', waiting: false, step: 0 },
  expired: { key: 'hlcOp_expired', tone: 'warn', waiting: false, step: 0 }, cancelled: { key: 'hlcOp_cancelled', tone: 'warn', waiting: false, step: 0 },
};
const WITHDRAW: Record<string, OpWords> = {
  pending_approval: { key: 'hlcOp_wd_pending_approval', tone: 'info', waiting: false, step: 0 }, approved: { key: 'hlcOp_wd_signed', tone: 'info', waiting: true, step: 1 }, signed: { key: 'hlcOp_wd_signed', tone: 'info', waiting: true, step: 1 },
  submitted: { key: 'hlcOp_wd_submitted', tone: 'info', waiting: true, step: 2 }, unknown: { key: 'hlcOp_wd_unknown', tone: 'warn', waiting: true, step: 1 },
  completed: { key: 'hlcOp_wd_completed', tone: 'ok', waiting: false, step: 3 }, rejected: { key: 'hlcOp_wd_rejected', tone: 'danger', waiting: false, step: 0 }, failed: { key: 'hlcOp_wd_failed', tone: 'danger', waiting: false, step: 0 },
  expired: { key: 'hlcOp_expired', tone: 'warn', waiting: false, step: 0 }, cancelled: { key: 'hlcOp_cancelled', tone: 'warn', waiting: false, step: 0 },
};
/** The words for an operation. Success (`ok`) exists for exactly two states; an unknown state is never good news. */
export function opWords(op: Pick<CollateralOp, 'kind' | 'state' | 'overdue' | 'final' | 'arrivalTracked'>): OpWords {
  const w = (op.kind === 'deposit' ? DEPOSIT : WITHDRAW)[op.state] ?? { key: 'hlcOp_other', tone: 'warn' as const, waiting: !op.final, step: 0 };
  if (op.overdue) return { ...w, key: op.kind === 'deposit' ? 'hlcOp_dep_overdue' : 'hlcOp_wd_overdue', tone: 'warn' };
  if (op.kind === 'withdraw' && op.state === 'completed' && op.arrivalTracked === false) return { ...w, key: 'hlcOp_wd_completed_untracked' };
  return w;
}
export const opDone = (op: Pick<CollateralOp, 'kind' | 'state'>): boolean => (op.kind === 'deposit' ? op.state === 'credited' : op.state === 'completed');
/** link to the wallet's cross-network USDC transfer (CCTP), pre-filled: from the network that holds USDC to the deposit network */
export const bridgeLink = (from: string, to: string, amount?: DecStr | null): string => `/swap?bridgeFrom=${encodeURIComponent(from)}&bridgeTo=${encodeURIComponent(to)}${amount ? `&amount=${encodeURIComponent(amount)}` : ''}`;
/** the codes the collateral routes answer with, each with its sentence (`hlcE_<code>`); anything else falls back to the generic notice */
export const COLLATERAL_CODES: ReadonlySet<string> = new Set(['below_minimum', 'no_route', 'mainnet_disabled', 'contract_changed', 'bridge_paused', 'route_not_proven', 'insufficient_usdc', 'policy', 'deposit_in_progress', 'pending_tx',
  'below_fee', 'insufficient_collateral', 'withdrawal_in_progress', 'expired', 'wrong_account', 'account_has_code', 'signer_venue_deposit', 'signer_wrong_destination', 'signer_bad_approval', 'insufficient_gas', 'insufficient_funds']);
