// Spot orders in the unified order table (V11 exec2).
//
// Execution is NOT here. The owner's spot order IS a swap proposal: quote, firm route, policy pre-check and the passkey request
// are the existing ones of POST /api/v1/swap/proposals (swap-exec.ts, swap-exec-sol.ts), and the swap then runs through the
// existing approval and execution (transfers.ts, worker.ts). `SpotPort` is the narrow seam to that flow: its default
// implementation calls the route IN PROCESS (`app.inject`) with the owner's own session cookie, origin and CSRF header taken from
// the incoming request, so authentication, CSRF, idempotency and every check of the handler are exactly what the Swap screen
// meets — nothing is copied. An API key or an agent never reaches it (403 `spot_execution_requires_agent_vault`).
//
// This file also holds the PURE mapping of the two spot sources onto the unified order (`advance()` of projection.ts applies it):
//   proposals  (kind = 'swap')   the owner's swaps, whether prepared here or in the Swap screen
//   agent_orders                 the spot agents' swaps, paper and live
// A database trigger queues every change of either table (db.ts); the order service projects them (service.ts `projectSpot`).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CASH_SYMBOLS, formatUnits, getAsset, getNetwork, KYBER_ENABLED, NETWORKS } from '@spw/core';
import { D, type DecStr } from '@spw/derivatives';
import type { OrderState, ReasonCode, UnifiedState } from '@spw/trading';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { executionOf } from '../exec-status.ts';
import type { ProposalRow } from '../transfers.ts';
import type { EngineSnapshot } from './projection.ts';
import type { NewOrder } from './store.ts';

/** the owner's session as the incoming request carried it: forwarded as it is, never built */
export interface SpotSession { cookie: string; origin: string; csrf: string }
export interface SpotRequest { network: string; fromAsset: string; toAsset: string; /** decimal amount of `fromAsset` (exact input) */ amount: string; slippageBps: number }
export interface SpotProposal { id: string; state: string; intentHash: string | null; expiresAt: number | null; /** the WebAuthn request of the existing flow: its challenge is the intent hash */ options: unknown }
export interface SpotPort {
  /** POST /api/v1/swap/proposals — a firm swap prepared for the owner's wallet, waiting for the passkey */
  propose(session: SpotSession, req: SpotRequest, idempotencyKey: string): Promise<SpotProposal>;
  /** POST /api/v1/transfers/proposals/:id/reject — only while the proposal waits for approval */
  withdraw(session: SpotSession, proposalId: string): Promise<void>;
}
export const SPOT_APPROVE_PATH = (proposalId: string): string => `/api/v1/transfers/proposals/${proposalId}/approve`;
/** the Idempotency-Key the swap route receives for an order: derived from the order id, in the route's own format */
export const proposalKeyOf = (orderId: string): string => `ord-${createHash('sha256').update(`spw-spot-order|${orderId}`).digest('hex').slice(0, 44)}`;

export function injectSpotPort(app: FastifyInstance): SpotPort {
  const call = async (session: SpotSession, url: string, payload: unknown, key?: string): Promise<Record<string, unknown>> => {
    if (!session.cookie) throw new UserError('owner_session_required', 'a spot order is prepared in the owner\'s own session: this request carries none', 403);
    const r = await app.inject({ method: 'POST', url, headers: { cookie: session.cookie, origin: session.origin, 'x-spw-csrf': session.csrf, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, payload: JSON.stringify(payload) });
    let json: Record<string, unknown> | null = null;
    try { json = r.json() as Record<string, unknown>; } catch { json = null; }
    if (r.statusCode >= 400 || !json) throw new UserError(String(json?.error ?? 'swap_flow_failed'), String(json?.message ?? `the swap flow answered HTTP ${r.statusCode}`).slice(0, 300), r.statusCode >= 400 ? r.statusCode : 502);
    return json;
  };
  return {
    async propose(session, req, key) {
      const j = await call(session, '/api/v1/swap/proposals', req, key), p = (j.proposal ?? j) as Record<string, unknown>;
      if (typeof p.id !== 'string') throw new UserError('swap_flow_failed', 'the swap flow returned no proposal', 502);
      return { id: p.id, state: String(p.state ?? ''), intentHash: (p.intentHash as string | null | undefined) ?? null, expiresAt: p.expiresAt ? new Date(p.expiresAt as string).getTime() : null, options: j.options ?? null };
    },
    async withdraw(session, id) { await call(session, `/api/v1/transfers/proposals/${id}/reject`, {}); },
  };
}

// ---------------------------------------------------------------------------------------------------------------- naming
/** a swap as a spot order: which leg is the base, which side. Spending a cash leg is a BUY of the other asset; anything else is a SELL of what is given. */
export function spotSide(fromSymbol: string, toSymbol: string): { side: 'buy' | 'sell'; base: string; quote: string } {
  return CASH_SYMBOLS.includes(fromSymbol) && !CASH_SYMBOLS.includes(toSymbol) ? { side: 'buy', base: toSymbol, quote: fromSymbol } : { side: 'sell', base: fromSymbol, quote: toSymbol };
}
export const spotInstrument = (base: string, quote: string): string => `spot:${base}-${quote}`;
/** the provider that executes a same-network swap on `network`, from the pinned tables; null = the wallet cannot execute there */
export function spotProvider(network: string): 'kyberswap' | 'jupiter' | null {
  let n; try { n = getNetwork(network); } catch { return null; }
  return n.family === 'sol' ? 'jupiter' : KYBER_ENABLED[network] ? 'kyberswap' : null;
}
/** registry asset of `symbol` on `network`: exactly one, or null */
export function assetBySymbol(network: string, symbol: string): { id: string; symbol: string; decimals: number } | null {
  let n; try { n = getNetwork(network); } catch { return null; }
  const all = [n.native, ...n.tokens].filter((a) => a.symbol.toUpperCase() === symbol.toUpperCase());
  return all.length === 1 ? { id: all[0]!.id, symbol: all[0]!.symbol, decimals: all[0]!.decimals } : null;
}
/** networks the wallet executes same-network swaps on */
export const spotNetworks = (): string[] => Object.keys(NETWORKS).filter((id) => spotProvider(id) !== null);

// ---------------------------------------------------------------------------------------------------------------- snapshots
const u = (state: OrderState, reason: ReasonCode, note: string | null = null): UnifiedState => ({ state, reason, note });
const units = (raw: string | null | undefined, decimals: number): DecStr | null => { try { return raw === null || raw === undefined ? null : D.str(D.from(formatUnits(BigInt(String(raw).split('.')[0]!), decimals))); } catch { return null; } };
const ratio = (a: DecStr | null, b: DecStr | null): DecStr | null => { try { return a !== null && b !== null && D.isPos(D.from(a)) && D.isPos(D.from(b)) ? D.str(D.div(D.from(a), D.from(b), 12, 'half_even')) : null; } catch { return null; } };
export interface SpotSource { engineRef: string; snapshot: EngineSnapshot; /** the unified order to create when none exists yet (a swap prepared in the Swap screen, an agent's swap) */ adopt: NewOrder; proposalKey: string | null; execution: unknown; engineState: string; engineReason: string | null }

/** the state of a swap proposal (transfers.ts) → the unified state */
export function mapSwapProposal(p: Pick<ProposalRow, 'state' | 'error' | 'broadcast_at'> & { error_code?: string | null }): UnifiedState {
  const code = p.error_code ?? '';
  switch (p.state as string) {
    case 'draft': return u('VALIDATED', 'VALIDATION_PASSED');
    case 'pending_approval': return u('AWAITING_APPROVAL', 'APPROVAL_REQUESTED');
    case 'approved': return u('APPROVED', 'APPROVED_BY_OWNER');
    case 'signed': return u('SUBMITTING', 'SUBMIT_STARTED', 'signed; the swap (or its token approval) has not been relayed yet');
    case 'broadcast': return u('SUBMITTED', 'VENUE_ACCEPTED', 'relayed to the network; not mined yet');
    case 'confirming': case 'reorged': return u('SUBMITTED', 'VENUE_ACCEPTED', 'mined; waiting for finality');
    case 'finalized': return u('FILLED', 'VENUE_FILLED');
    case 'rejected': return u('CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL');
    case 'expired': return u('CANCELLED', 'APPROVAL_EXPIRED');
    case 'not_broadcast': return u('FAILED', 'NOT_SENT', 'broadcast is disabled on this server; nothing was sent');
    case 'replaced': return u('FAILED', 'TX_REPLACED');
    case 'failed':
      if (code === 'signer_hash_mismatch') return u('FAILED', 'SIGNER_HASH_MISMATCH');
      if (/^signer_/.test(code)) return u('REJECTED', 'SIGNER_REFUSED');
      if (p.broadcast_at) return u('FAILED', 'TX_REVERTED', 'the transaction left the wallet and did not succeed');
      if (/approval_reverted$/.test(code)) return u('FAILED', 'TX_REVERTED', 'the token approval reverted; the swap itself was never sent');
      return u('FAILED', 'NOT_SENT', 'the swap was never sent');
    default: return u('FAILED', 'INTERNAL_ERROR', `the proposal state '${String(p.state).slice(0, 30)}' is not one this mapping knows`);
  }
}
/** the state of a spot agent's order (agents/engine.ts paper fills, agents/live.ts) → the unified state */
export function mapAgentOrder(state: string, reason: string | null, mode: string): UnifiedState {
  const t = reason ?? '';
  switch (state) {
    case 'filled': return u('FILLED', 'VENUE_FILLED', mode === 'LIVE' ? null : 'paper: filled at the provider\'s live quote; nothing was signed');
    case 'prepared': return u('APPROVED', 'APPROVED_BY_MANDATE', 'the order exists; the signer has not answered yet');
    case 'signed': return u('SUBMITTING', 'SUBMIT_STARTED', 'signed under the vault mandate; not relayed yet');
    case 'broadcast': return u('SUBMITTED', 'VENUE_ACCEPTED');
    case 'failed':
      if (/refused by the signer/i.test(t)) return u('REJECTED', 'SIGNER_REFUSED');
      if (/never signed/i.test(t)) return u('FAILED', 'SIGNER_INTERRUPTED');
      if (/reverted on-chain|approval reverted/i.test(t)) return u('FAILED', 'TX_REVERTED');
      if (/not included/i.test(t)) return u('FAILED', 'INTERNAL_ERROR', 'relayed and not included before its deadline');
      return u('FAILED', 'NOT_SENT');
    default: return u('FAILED', 'INTERNAL_ERROR', `the agent order state '${state.slice(0, 30)}' is not one this mapping knows`);
  }
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a database row
/** a swap proposal row → what the projector needs. Pure. */
export function swapSource(p: ProposalRow & { idempotency_key?: string | null }): SpotSource {
  const sw = p.swap, toSymbol = sw?.toSymbol ?? '?', s = spotSide(p.symbol, toSymbol), target = mapSwapProposal(p);
  const amountIn = units(p.amount, p.decimals), out = sw ? units(p.out_amount, sw.toDecimals) : null, expected = sw ? units(sw.expectedOut, sw.toDecimals) : null;
  // the size of a spot order is a quantity of its BASE asset: what is sold, or — for a buy — what was received (unknown before the swap settles)
  const size = s.side === 'sell' ? amountIn : null, done = target.state === 'FILLED';
  const filled: DecStr = !done ? '0' : s.side === 'sell' ? amountIn ?? '0' : out ?? '0';
  const avg = !done ? null : s.side === 'sell' ? ratio(out, amountIn) : ratio(amountIn, out);
  let execution: unknown = null;
  try { execution = executionOf(p); } catch { execution = null; }
  const detail = [p.error_code ?? null, p.error ?? null].filter(Boolean).join(': ') || null;
  return {
    engineRef: `swap:${p.id}`, proposalKey: p.idempotency_key ?? null, execution, engineState: p.state, engineReason: detail,
    snapshot: { target, filled, avg, venueOrderId: p.txid ?? null, approval: 'owner', venue: 'spot', requestExpiresAt: p.expires_at ? p.expires_at.getTime() : null, detail,
      sig: `s|${p.state}|${p.pre_state ?? ''}|${p.txid ?? ''}|${p.out_amount ?? ''}|${p.error_code ?? ''}` },
    adopt: { id: `adopt-${createHash('sha256').update(`swap|${p.id}`).digest('hex').slice(0, 40)}`, principal: { kind: 'owner', id: 'owner' }, idempotencyKey: null, bodyHash: null, mode: 'live', venue: 'spot', network: p.network,
      instrument: spotInstrument(s.base, s.quote), marketKind: 'spot', side: s.side, type: 'market', reduceOnly: false, accountId: p.from_addr, mandateId: null, canonical: null, orderHash: p.intent_hash ?? null, size, engine: 'spot',
      engineRef: `swap:${p.id}`, notionalUsd: null, origin: 'legacy',
      detail: { clientId: `swap:${p.id}`, proposalId: p.id, provider: sw?.provider ?? null, fromSymbol: p.symbol, toSymbol, amountIn, expectedOut: expected, minOut: sw ? units(sw.minOut, sw.toDecimals) : null, slippageBps: sw?.slippageBps ?? null, tif: 'ioc', price: null, triggerPrice: null },
      createdAt: p.created_at.getTime() },
  };
}
/** an agent_orders row (joined with its agent's network and cash leg) → what the projector needs. Pure. */
export function agentSwapSource(r: Row): SpotSource {
  const mode: 'paper' | 'live' = r.mode === 'LIVE' ? 'live' : 'paper', s = spotSide(String(r.from_symbol), String(r.to_symbol)), target = mapAgentOrder(String(r.state), (r.reason as string | null) ?? null, String(r.mode));
  const dec = (asset: string): number | null => { try { return getAsset(String(r.network), asset).decimals; } catch { return null; } };
  const fd = dec(String(r.from_asset)), td = dec(String(r.to_asset));
  const amountIn = fd === null ? null : units(r.amount_in as string, fd), received = td === null ? null : units(r.received as string | null, td), expected = td === null ? null : units(r.expected_out as string | null, td);
  const size = s.side === 'sell' ? amountIn : null, done = target.state === 'FILLED';
  const filled: DecStr = !done ? '0' : s.side === 'sell' ? amountIn ?? '0' : received ?? '0';
  const usd = (r.aux as { usd?: number } | null)?.usd;
  return {
    engineRef: `agent:${r.id}`, proposalKey: null, execution: null, engineState: String(r.state), engineReason: target.state === 'FILLED' ? null : (r.reason as string | null) ?? null,
    snapshot: { target, filled, avg: !done ? null : s.side === 'sell' ? ratio(received, amountIn) : ratio(amountIn, received), venueOrderId: (r.txid as string | null) ?? null, approval: 'mandate', venue: 'spot', requestExpiresAt: null,
      detail: target.state === 'FILLED' ? null : (r.reason as string | null) ?? null, sig: `a|${r.state}|${r.txid ?? ''}|${r.received ?? ''}|${target.state === 'FILLED' ? '' : r.reason ?? ''}` },
    adopt: { id: `adopt-${createHash('sha256').update(`agent_swap|${r.id}`).digest('hex').slice(0, 40)}`, principal: { kind: 'agent', id: String(r.agent_id) }, idempotencyKey: null, bodyHash: null, mode, venue: 'spot', network: String(r.network),
      instrument: spotInstrument(s.base, s.quote), marketKind: 'spot', side: s.side, type: 'market', reduceOnly: false, accountId: String(r.agent_id), mandateId: null, canonical: null, orderHash: null, size, engine: 'spot',
      engineRef: `agent:${r.id}`, notionalUsd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? D.str(D.from(usd.toFixed(6))) : null, origin: 'legacy',
      detail: { clientId: `agent:${r.id}`, agentId: r.agent_id, agentOrderId: r.id, provider: 'kyberswap', fromSymbol: r.from_symbol, toSymbol: r.to_symbol, amountIn, expectedOut: expected, received, strategyReason: target.state === 'FILLED' ? (r.reason as string | null) ?? null : null, tif: 'ioc', price: null, triggerPrice: null },
      createdAt: (r.ts as Date).getTime() },
  };
}

/** reads the source row of a queued change; null when it is gone or is not a swap */
export async function loadSpotSource(kind: 'swap' | 'agent_swap', ref: string): Promise<SpotSource | null> {
  if (!/^[0-9a-f-]{36}$/.test(ref)) return null;
  if (kind === 'swap') {
    const [p] = await sql<(ProposalRow & { idempotency_key: string | null })[]>`select * from proposals where id = ${ref} and kind = 'swap'`;
    return p ? swapSource(p) : null;
  }
  const [r] = await sql`select o.*, a.network, a.cash from agent_orders o join agents a on a.id = o.agent_id where o.id = ${ref}`;
  return r ? agentSwapSource(r) : null;
}
