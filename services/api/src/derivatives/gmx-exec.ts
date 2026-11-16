// GMX v2 trading (v8) — the execution engine. Facts, pins and evidence: docs/v4/venues/gmx.md Part C; routes and shapes:
// docs/v4/API-LIVE-NOTES.md ("GMX v2 trading").
//
// A GMX order is a wallet transaction, so it travels as an ordinary wallet PROPOSAL (table `proposals`, kind `gmx`: prepare →
// simulate → passkey → signer → broadcast → receipt, one transaction in flight per network) whose intent carries a `gmx`
// section; a row of `deriv_gmx_ops` then follows the ORDER: its key comes from the `OrderCreated` event of the receipt, and
// it is tracked on-chain (Reader + the EventEmitter's logs) until GMX's keepers executed it, cancelled it or froze it.
// "created" is never shown as "executed"; an order that cannot be found is `unknown`, never assumed.
//
// What this file can NOT do: it holds no key and builds no transaction that gets signed — the signer rebuilds everything from
// the intent and refuses anything outside the pinned contracts, the fixed fields and the venue policy the owner approved.
// Three locks: SPW_DERIV_LIVE_MAINNET=on, SPW_DERIV_GMX_LIVE=on (default off), and that passkey-approved venue policy.
import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { decodeEventLog, erc20Abi, formatUnits, toFunctionSelector, type Hex } from 'viem';
import { z } from 'zod';
import { checkPolicy, checkPolicyNoSpend, getNetwork, IntentSchema, intentHash, toB64u, toHex, type Intent, type Policy } from '@spw/core';
import { checkOrder, D, gmxBalanceOi, gmxPriceImpact, liquidationPriceIsolated, type AccountState, type Dec, type DecStr, type GmxLiquidity, type Instrument, type Position, type RiskPolicy, type Ticker } from '@spw/derivatives';
import {
  buildGmxTxs, decodeGmxEvent, GMX_GAS, GMX_MARKETS, GMX_PINNED_CONTRACTS, GMX_PINS, GMX_POLICY_BOUNDS, GMX_REQUEST_EXPIRATION_SEC, gmxAcceptablePrice, GmxAuthorizationSchema, gmxAuthorizationHash, gmxEventKey, gmxExecutionFee,
  gmxMarket, gmxOrderCreatedDiff, gmxPolicyVerdict, gmxPriceFromRaw, gmxUsdFromRaw, gmxUsdToRaw, hex, jurisdictionAck, scaleExact, unscale, validateGmxAuthorization, verifyGmxIntent, ZERO_ADDRESS,
  type GmxAuthorization, type GmxEvent, type GmxMarketPin, type GmxPolicy, type GmxSection,
} from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { canonicalIntentHash, RISK_INTENT_TTL_MS } from './exec.ts';
import { audit, getSetting, sql } from '../db.ts';
import { move, type ProposalRow } from '../transfers.ts';
import type { GmxChain, GmxChainOrder, GmxChainPosition, GmxPinCheck, GmxReceipt } from './gmx-chain.ts';

export const GMX_STEP_MS = 5_000;
/** a `created` order no keeper touched after this long is flagged (tracking goes on) */
export const GMX_KEEPER_OVERDUE_MS = 10 * 60_000;
/** a sent transaction without a receipt after this long is `unknown` (tracking goes on) */
export const GMX_RECEIPT_OVERDUE_MS = 15 * 60_000;
const TTL_SEC = 180, FIXED_ORDER_GAS = 2_500_000n, APPROVE_GAS = 60_000n, EXPECTED_ORDER_GAS = 1_000_000n, SEND_WINDOW_MS = 8 * 60_000;
const LOCALES = ['fr', 'en'] as const;
type Locale = (typeof LOCALES)[number];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const lc = (s: string) => s.toLowerCase();
const WEI = 18;
/** custom errors of GMX seen as cancellation reasons, by selector (the first is the one produced on the fork proof) */
const GMX_ERROR_NAMES: Record<string, string> = { [toFunctionSelector('OrderNotFulfillableAtAcceptablePrice(uint256,uint256)')]: 'OrderNotFulfillableAtAcceptablePrice: the oracle price was beyond the acceptable price of the order' };
/** a decimal rounded to `dp` places (display of estimates; never feeds a transaction) */
const rd = (d: Dec, dp = 6): DecStr => D.str(D.div(d, D.one, dp, 'half_even'));

export type GmxBlocker = 'gmx_setting_off' | 'mainnet_setting_off' | 'not_authorized' | 'authorization_expired' | 'authorization_revoked' | 'contracts_changed' | 'signer_halted' | 'gmx_halted' | 'chain_unreadable' | 'wallet_unreadable';
export const GMX_BLOCKER_TEXT: Record<GmxBlocker, Record<Locale, string>> = {
  gmx_setting_off: { en: 'GMX trading is disabled on this server (SPW_DERIV_GMX_LIVE is not "on"). It is a server setting: it cannot be changed from the app. Reading stays available.', fr: 'La négociation sur GMX est désactivée sur ce serveur (SPW_DERIV_GMX_LIVE n\'est pas « on »). C\'est un réglage du serveur : il ne se modifie pas depuis l\'application. La lecture reste disponible.' },
  mainnet_setting_off: { en: 'Live derivative trading on mainnet is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on"). It is a server setting.', fr: 'La négociation réelle de dérivés sur le réseau principal est désactivée sur ce serveur (SPW_DERIV_LIVE_MAINNET n\'est pas « on »). C\'est un réglage du serveur.' },
  not_authorized: { en: 'No venue policy is approved: approve one with your passkey to trade on GMX.', fr: 'Aucune politique de plateforme n\'est approuvée : approuvez-en une avec votre clé d\'accès pour négocier sur GMX.' },
  authorization_expired: { en: 'The GMX authorization has expired: approve a new one.', fr: 'L\'autorisation GMX a expiré : approuvez-en une nouvelle.' },
  authorization_revoked: { en: 'The GMX authorization was revoked: approve a new one.', fr: 'L\'autorisation GMX a été révoquée : approuvez-en une nouvelle.' },
  contracts_changed: { en: 'GMX has published new contracts: a new review is needed. Nothing is signed for GMX until this wallet\'s pinned table is reviewed again.', fr: 'GMX a publié de nouveaux contrats : nouvelle revue nécessaire. Rien n\'est signé pour GMX tant que la table épinglée de ce portefeuille n\'a pas été revue.' },
  signer_halted: { en: 'The signer\'s emergency halt is active: no new position is signed. Closing a position and cancelling a pending order stay possible.', fr: 'L\'arrêt d\'urgence du signataire est actif : aucune nouvelle position n\'est signée. Fermer une position et annuler un ordre en attente restent possibles.' },
  gmx_halted: { en: 'GMX trading is halted on this wallet: no new position is prepared. Closing a position and cancelling a pending order stay possible.', fr: 'La négociation sur GMX est suspendue sur ce portefeuille : aucune nouvelle position n\'est préparée. Fermer une position et annuler un ordre en attente restent possibles.' },
  chain_unreadable: { en: 'Arbitrum could not be read: the contracts cannot be checked right now.', fr: 'Arbitrum n\'a pas pu être lu : les contrats ne peuvent pas être vérifiés pour le moment.' },
  wallet_unreadable: { en: 'The signer could not be reached: the wallet address and limits are unknown.', fr: 'Le signataire est injoignable : l\'adresse et les limites du portefeuille sont inconnues.' },
};

// ---------------------------------------------------------------------------------------------------------------------------
// Ports (replaced by fakes in tests)

export interface GmxSignerAuth { authorization: GmxAuthorization; hash: string; approvedAt: string; revoked: boolean; revokedAt: string | null; expired: boolean; current: boolean; today: { increases: number; reduces: number } }
export interface GmxSignerPort {
  status(fresh?: boolean): Promise<{ keyId: string; halted: boolean; addresses: Record<string, string>; policy: Policy; spentToday: Record<string, string>; gmx?: GmxSignerAuth[] }>;
  sign(intent: unknown, assertion: unknown): Promise<{ raw: string; txid: string; hash: string; pre?: { raw: string; txid: string } }>;
  gmxAuthorize(authorization: unknown, assertion: unknown): Promise<{ authorizationId: string; hash: string }>;
  gmxRevoke(authorizationId: string): Promise<{ revoked: true; revokedAt: string }>;
}
export interface GmxMarketPort {
  /** the venue's own market data for one pinned instrument: oracle range, open interest, fee and impact factors, rates */
  market(instrument: string): Promise<{ instrument: Instrument; ticker: Ticker; liquidity: GmxLiquidity | null }>;
  /** positions of an address as GMX's API reports them — a CROSS-CHECK of the on-chain read, never the source */
  apiPositions(account: string): Promise<Position[]>;
}
export interface GmxDeps {
  chain: GmxChain; signer: GmxSignerPort; market: GmxMarketPort; now: () => number; rpId: string;
  credentials: () => Promise<{ id: string; transports?: string[] | null }[]>;
  settings: () => { liveMainnet: boolean; gmxLive: boolean };
  /** V11: verifies a passkey assertion over `challenge` (loosening a loss limit, lifting the halt); absent = those changes are refused */
  verifyOwner?: (assertion: unknown, challenge: Uint8Array) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Bodies

const Dec = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,18})?$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const GmxOrderBodySchema = z.strictObject({ market: Address, side: z.enum(['long', 'short']), action: z.enum(['increase', 'decrease']), collateral: Dec.optional(), leverage: Dec.optional(), sizeUsd: Dec.optional(), slippageBps: z.number().int().min(1).max(500).default(50) });
export type GmxOrderBody = z.infer<typeof GmxOrderBodySchema>;
export const GmxCloseBodySchema = z.strictObject({ market: Address, side: z.enum(['long', 'short']), fraction: Dec.default('1'), slippageBps: z.number().int().min(1).max(500).default(50) });
export const GmxAuthBodySchema = z.strictObject({ allowedMarkets: z.array(Address).min(1).max(GMX_POLICY_BOUNDS.maxMarkets), maxLeverage: z.number().int().min(1).max(GMX_POLICY_BOUNDS.maxLeverage), maxOrderSizeUsd: Dec,
  maxOrdersPerDay: z.number().int().min(1).max(GMX_POLICY_BOUNDS.maxOrdersPerDay), maxPriceDeviationBps: z.number().int().min(GMX_POLICY_BOUNDS.minPriceBandBps).max(GMX_POLICY_BOUNDS.maxPriceBandBps),
  days: z.number().int().min(1).max(GMX_POLICY_BOUNDS.maxDays), locale: z.enum(LOCALES).default('fr') });
export const GmxApproveAuthSchema = z.strictObject({ authorization: GmxAuthorizationSchema, assertion: z.record(z.string(), z.unknown()) });
export const GmxAssertionSchema = z.strictObject({ assertion: z.record(z.string(), z.unknown()) });
export const GmxHaltBodySchema = z.strictObject({ reason: z.string().trim().max(200).default('') });
export const GmxLimitsBodySchema = z.strictObject({ maxDailyLoss: Dec, maxTotalLoss: Dec });

// ---------------------------------------------------------------------------------------------------------------------------
// V11 (B-10) — API-side loss limits and kill switch of GMX trading, on the model of a Hyperliquid venue account (exec.ts):
// a daily and a total loss limit (realised by this wallet's executed orders + unrealised on the open positions), and an owner
// halt. Both stop NEW risk only: a decrease or a cancellation is never refused by them. Tightening and halting are free;
// loosening a limit and lifting the halt need the owner's passkey over a canonical intent. Stored in `settings`, bound to
// the authorization they were set under: a new authorization (passkey) starts from the defaults, without a halt.

/** the gross exposure the GMX risk policy allows, in multiples of the authorized order size (unchanged from v8) */
const GMX_GROSS_MULTIPLE = '3';
export interface GmxRiskLimits { maxDailyLoss: DecStr; maxTotalLoss: DecStr }
interface GmxRisk extends GmxRiskLimits { authorizationId: string; halt: string | null }
const GMX_RISK_KEY = 'deriv.gmx.risk', GMX_RISK_PENDING = 'deriv.gmx.risk.pending';
/** defaults: 5 % and 20 % of the allowed gross exposure — the fractions of `liveRiskPolicy` for a Hyperliquid account */
export function gmxDefaultLimits(pol: Pick<GmxPolicy, 'maxOrderSizeUsd'>): GmxRiskLimits {
  const gross = D.mul(D.from(pol.maxOrderSizeUsd), D.from(GMX_GROSS_MULTIPLE));
  return { maxDailyLoss: D.str(D.mul(gross, D.from('0.05'))), maxTotalLoss: D.str(D.mul(gross, D.from('0.2'))) };
}
export interface GmxRiskIntent { v: 1; kind: 'gmx-limits' | 'gmx-resume'; authorizationId: string; limits: GmxRiskLimits | null; loosened: string[]; subject: string | null; nonce: string; createdAt: number; expiresAt: number }
export const gmxRiskIntentHash = (i: GmxRiskIntent): Uint8Array => canonicalIntentHash('SPW-GMX-RISK-INTENT-v1', i);

/** which of the two loss limits `next` raises above `cur` */
const gmxLoosened = (cur: GmxRiskLimits, next: GmxRiskLimits): string[] => (['maxDailyLoss', 'maxTotalLoss'] as const).filter((k) => D.gt(D.from(next[k]), D.from(cur[k])));

export type GmxOpState = 'pending_approval' | 'signed' | 'sent' | 'created' | 'executed' | 'cancelled' | 'frozen' | 'done' | 'failed' | 'expired' | 'withdrawn' | 'unknown';
interface Row {
  id: string; idempotency_key: string | null; kind: 'increase' | 'decrease' | 'cancel'; state: GmxOpState; final: boolean; account: string; market: string | null; is_long: boolean | null; collateral_token: string | null;
  amount: string | null; size_usd: string | null; acceptable_price: string | null; slippage_bps: number | null; execution_fee: string; max_fee: string; needs_approval: boolean; order_key: string | null; target_op: string | null;
  proposal_id: string | null; op_hash: string | null; txid: string | null; pre_txid: string | null; block_number: string | null; request: Record<string, any>; estimate: Record<string, any> | null; outcome: Record<string, any> | null;
  error: string | null; attempts: number; expires_at: Date | null; sent_at: Date | null; order_created_at: Date | null; done_at: Date | null; checked_at: Date | null; created_at: Date; updated_at: Date;
}
interface Computed {
  /** V11: the order as the unified risk gate takes it, and what was read for it */
  gate: { req: import('@spw/derivatives').OrderRequest; instrument: Instrument; ticker: Ticker; position: Position | null };
  pin: GmxMarketPin; isLong: boolean; increase: boolean; amount: bigint; sizeRaw: bigint; acceptable: bigint; slippageBps: number; leverage: DecStr | null;
  estimate: Record<string, any>; risk: { ok: true } | { ok: false; code: string; reason: string }; signerWould: string | null; executionFee: bigint; base: bigint; tip: bigint;
}

export class GmxService {
  readonly deps: GmxDeps;
  readonly now: () => number;
  /** V11: the unified risk gate and the global kill switch / read-only mode (derivatives/gate.ts), set by the server */
  preTrade: import('./gate.ts').PreTradeGate | null = null;
  newRiskBlock: import('./gate.ts').NewRiskBlock | null = null;
  constructor(deps: GmxDeps) { this.deps = deps; this.now = deps.now; }

  // ------------------------------------------------------------------ helpers

  private async set(r: Row, patch: Record<string, unknown>, from?: GmxOpState): Promise<Row> {
    const p = { ...patch, updated_at: new Date(this.now()) };
    const [u] = from === undefined ? await sql<Row[]>`update deriv_gmx_ops set ${sql(p as never)} where id = ${r.id} returning *` : await sql<Row[]>`update deriv_gmx_ops set ${sql(p as never)} where id = ${r.id} and state = ${from} returning *`;
    if (!u) throw new UserError('conflict', 'the operation changed concurrently; reload', 409);
    return u;
  }
  private async row(id: string): Promise<Row> {
    const [r] = await sql<Row[]>`select * from deriv_gmx_ops where id = ${id}`;
    if (!r) throw new UserError('unknown_operation', 'unknown GMX operation', 404);
    return r;
  }
  private log(type: string, r: Row, data: Record<string, unknown> = {}, actor = 'system'): Promise<void> {
    return audit(`deriv.gmx.${type}`, actor, { id: r.id, kind: r.kind, market: r.market, isLong: r.is_long, amount: r.amount, sizeUsd: r.size_usd, orderKey: r.order_key, txid: r.txid, ...data }).catch((e: Error) => console.error(`[gmx] audit ${type} failed: ${e.message}`));
  }
  private async options(hash: Uint8Array, ttlSec: number) {
    const creds = await this.deps.credentials();
    const options = await generateAuthenticationOptions({ rpID: this.deps.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: ttlSec * 1000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return options;
  }
  private authOf(st: { gmx?: GmxSignerAuth[] }): GmxSignerAuth | null {
    const all = st.gmx ?? [];
    return all.find((a) => !a.revoked && !a.expired && a.current) ?? [...all].sort((x, y) => y.authorization.createdAt - x.authorization.createdAt)[0] ?? null;
  }
  private authState(a: GmxSignerAuth): 'active' | 'expired' | 'revoked' | 'stale' { return a.revoked ? 'revoked' : !a.current ? 'stale' : a.expired ? 'expired' : 'active'; }
  private explorer = (kind: 'tx' | 'addr', v: string) => { const n = getNetwork(GMX_PINS.network); return (kind === 'tx' ? n.explorerTx : n.explorerAddr) + v; };

  /** the gates of everything that prepares or approves: both server settings, the signer, an active authorization, the pins */
  /**
   * `exit` (V11, B-01 / B-02): closing an EXISTING position (a decrease) or cancelling a pending order. The two server settings
   * and the signer's emergency halt stop new risk only; the way out needs the authorization and the pins, nothing else.
   */
  private async gate(needAuth = true, exit = false): Promise<{ st: Awaited<ReturnType<GmxSignerPort['status']>>; me: string; auth: GmxSignerAuth | null; pins: GmxPinCheck }> {
    const s = this.deps.settings();
    if (!exit && !s.gmxLive) throw new UserError('gmx_disabled', `${GMX_BLOCKER_TEXT.gmx_setting_off.en} Nothing was built, signed or sent.`, 403);
    if (!exit && !s.liveMainnet) throw new UserError('mainnet_disabled', `${GMX_BLOCKER_TEXT.mainnet_setting_off.en} Nothing was built, signed or sent.`, 403);
    const st = await this.deps.signer.status(true), me = st.addresses[GMX_PINS.network];
    if (!me) throw new UserError('unsupported_network', 'the signer has no key for Arbitrum', 503);
    if (st.halted && !exit) throw new UserError('halted', 'emergency halt is active', 423);
    const auth = this.authOf(st);
    if (needAuth && (!auth || this.authState(auth) !== 'active')) throw new UserError('not_authorized', auth ? `the GMX authorization is ${this.authState(auth)}: approve a new one` : 'GMX trading is not authorized: approve a venue policy with your passkey first', 409);
    const pins = await this.deps.chain.checkPins(me);
    if (!pins.ok) throw new UserError('contract_changed', `GMX a publié de nouveaux contrats : nouvelle revue nécessaire (${pins.problems.join('; ').slice(0, 240)}). Nothing was built, signed or sent.`, 503);
    return { st, me, auth, pins };
  }

  // ------------------------------------------------------------------ views

  private opView(r: Row) {
    const pin = r.market ? gmxMarket(r.market) : null, c = pin?.collateral.find((x) => r.collateral_token && lc(x.token) === lc(r.collateral_token)) ?? null, now = this.now();
    const created = r.order_created_at?.getTime() ?? null;
    return {
      id: r.id, kind: r.kind, state: r.state, final: r.final, market: r.market, marketName: pin?.name ?? null, side: r.is_long === null ? null : r.is_long ? 'long' as const : 'short' as const,
      collateral: r.amount !== null && c && r.kind === 'increase' ? formatUnits(BigInt(r.amount), c.decimals) : null, collateralSymbol: c?.symbol ?? null,
      sizeUsd: r.size_usd !== null ? gmxUsdFromRaw(BigInt(r.size_usd)) : null, acceptablePrice: r.acceptable_price !== null && pin ? gmxPriceFromRaw(BigInt(r.acceptable_price), pin.indexDecimals) : null,
      slippageBps: r.slippage_bps, leverage: (r.request.leverage as string | undefined) ?? null, executionFeeEth: formatUnits(BigInt(r.execution_fee), WEI), maxFeeEth: formatUnits(BigInt(r.max_fee), WEI), needsApproval: r.needs_approval,
      orderKey: r.order_key, targetOpId: r.target_op, hash: r.op_hash, proposalId: r.proposal_id, txid: r.txid, explorer: r.txid ? this.explorer('tx', r.txid) : null, approvalTxid: r.pre_txid,
      createdAt: r.created_at.getTime(), expiresAt: r.expires_at?.getTime() ?? null, sentAt: r.sent_at?.getTime() ?? null, orderCreatedAt: created, doneAt: r.done_at?.getTime() ?? null, checkedAt: r.checked_at?.getTime() ?? null,
      cancellableAt: created !== null && (r.state === 'created' || r.state === 'frozen') ? (r.state === 'frozen' ? created : created + GMX_REQUEST_EXPIRATION_SEC * 1000) : null,
      overdue: r.state === 'created' && created !== null && now - created > GMX_KEEPER_OVERDUE_MS, estimate: r.estimate, outcome: r.outcome, error: r.error,
    };
  }
  private posView(p: GmxChainPosition, mark: Dec | null, liq: GmxLiquidity | null, api: Position[] | null) {
    const pin = gmxMarket(p.market), c = pin?.collateral.find((x) => lc(x.token) === lc(p.collateralToken)) ?? null, dec = pin?.indexDecimals ?? 18, cd = c?.decimals ?? 6;
    const sizeUsd = D.from(gmxUsdFromRaw(p.sizeInUsd)), tokens = D.from(unscale(p.sizeInTokens, dec)), coll = D.from(unscale(p.collateralAmount, cd));
    const entry = D.isZero(tokens) ? null : D.div(sizeUsd, tokens, 12, 'half_even');
    const pnl = mark && entry ? (p.isLong ? D.sub(D.mul(tokens, mark), sizeUsd) : D.sub(sizeUsd, D.mul(tokens, mark))) : null;
    let liqPx: DecStr | null = null;
    try { if (liq && entry && !D.isZero(tokens)) { const v = liquidationPriceIsolated({ side: p.isLong ? 'long' : 'short', size: tokens, entryPrice: entry, margin: coll, maintenanceFraction: D.from(liq.minCollateralFactorForLiquidation), feeRate: D.from(liq.positionFeeFactor.balanceNotImproved) }).value; liqPx = v ? rd(v, 2) : null; } } catch { liqPx = null; }
    // cross-check with GMX's own API: same market, side and size (the API is an indexer: a short lag is possible)
    let agrees: boolean | null = null, detail: string | null = null;
    if (api && pin) {
      const m = api.find((x) => x.instrument === pin.instrument && x.side === (p.isLong ? 'long' : 'short'));
      if (!m) { agrees = false; detail = 'GMX\'s API does not list this position (its indexer may lag)'; }
      else { const diff = D.abs(D.sub(D.from(m.size), tokens)); agrees = D.cmp(D.mul(diff, D.from('1000')), tokens) <= 0; detail = agrees ? null : `GMX's API reports ${m.size} tokens, the chain ${D.str(tokens)}`; }
    }
    return { key: p.key, market: p.market, marketName: pin?.name ?? p.market, instrument: pin?.instrument ?? null, side: p.isLong ? 'long' as const : 'short' as const, collateralToken: p.collateralToken, collateralSymbol: c?.symbol ?? '?',
      sizeUsd: D.str(sizeUsd), sizeTokens: D.str(tokens), collateral: D.str(coll), entryPrice: entry ? rd(entry, 4) : '0', markPrice: mark ? D.str(mark) : null,
      pnlUsd: pnl ? rd(pnl) : null, leverage: D.isZero(coll) ? null : D.str(D.div(sizeUsd, coll, 2, 'half_even')), liquidationPrice: liqPx, increasedAt: p.increasedAtTime, source: 'chain' as const, venueApi: { agrees, detail } };
  }
  private orderView(o: GmxChainOrder, ops: Row[]) {
    const pin = gmxMarket(o.market), c = pin?.collateral.find((x) => lc(x.token) === lc(o.initialCollateralToken));
    return { key: o.key, market: o.market, marketName: pin?.name ?? o.market, orderType: ['MarketSwap', 'LimitSwap', 'MarketIncrease', 'LimitIncrease', 'MarketDecrease', 'LimitDecrease', 'StopLossDecrease', 'Liquidation', 'StopIncrease'][o.orderType] ?? String(o.orderType),
      side: o.isLong ? 'long' as const : 'short' as const, sizeUsd: gmxUsdFromRaw(o.sizeDeltaUsd), collateral: formatUnits(o.initialCollateralDeltaAmount, c?.decimals ?? 6), acceptablePrice: pin ? gmxPriceFromRaw(o.acceptablePrice, pin.indexDecimals) : o.acceptablePrice.toString(),
      executionFeeEth: formatUnits(o.executionFee, WEI), updatedAt: o.updatedAtTime, cancellableAt: o.isFrozen ? o.updatedAtTime : o.updatedAtTime + GMX_REQUEST_EXPIRATION_SEC, frozen: o.isFrozen, opId: ops.find((r) => r.order_key === o.key)?.id ?? null };
  }

  async status(locale: Locale = 'en') {
    const settings = this.deps.settings(), n = getNetwork(GMX_PINS.network), blockers: GmxBlocker[] = [];
    if (!settings.gmxLive) blockers.push('gmx_setting_off');
    if (!settings.liveMainnet) blockers.push('mainnet_setting_off');
    let st: Awaited<ReturnType<GmxSignerPort['status']>> | null = null, walletError: string | null = null;
    try { st = await this.deps.signer.status(); } catch (e) { walletError = msg(e); blockers.push('wallet_unreadable'); }
    const me = st?.addresses[GMX_PINS.network] ?? null, auth = st ? this.authOf(st) : null, as = auth ? this.authState(auth) : null;
    if (st?.halted) blockers.push('signer_halted');
    const risk = await this.riskView(auth).catch(() => null);
    if (risk?.halt) blockers.push('gmx_halted');
    if (st && (!auth || as === 'stale')) blockers.push(as === 'stale' ? 'contracts_changed' : 'not_authorized'); else if (as === 'expired') blockers.push('authorization_expired'); else if (as === 'revoked') blockers.push('authorization_revoked');
    let pins: { ok: boolean | null; problems: string[]; checkedAt: number | null } = { ok: null, problems: [], checkedAt: null };
    try { pins = await this.deps.chain.checkPins(me); if (!pins.ok && !blockers.includes('contracts_changed')) blockers.push('contracts_changed'); }
    catch (e) { pins = { ok: null, problems: [msg(e)], checkedAt: null }; blockers.push('chain_unreadable'); }

    let wallet = null;
    if (st && me) {
      try {
        const b = await this.deps.chain.balances(me), key = `${n.id}:USDC`;
        const perTx = BigInt(st.policy.perTx[key] ?? '0'), perDay = BigInt(st.policy.daily[key] ?? '0'), spent = BigInt(st.spentToday[key] ?? '0'), room = perDay > spent ? perDay - spent : 0n;
        wallet = { usdc: formatUnits(b.usdc, 6), eth: formatUnits(b.eth, WEI), weth: formatUnits(b.weth, WEI), limits: { perTransfer: formatUnits(perTx, 6), perDay: formatUnits(perDay, 6), spentToday: formatUnits(spent, 6), maxNow: formatUnits([perTx, room, b.usdc].reduce((x, y) => (y < x ? y : x)), 6) },
          feeCeilingEth: formatUnits(BigInt(st.policy.maxFee[n.id] ?? '0'), WEI) };
      } catch (e) { walletError = msg(e); }
    }
    const data = new Map<string, { mark: Dec | null; liq: GmxLiquidity | null }>();
    await Promise.all(GMX_MARKETS.map(async (m) => { try { const x = await this.deps.market.market(m.instrument); data.set(m.market, { mark: x.liquidity ? D.div(D.add(D.from(x.liquidity.oracleMin), D.from(x.liquidity.oracleMax)), D.from('2'), 12, 'half_even') : D.from(x.ticker.mark), liq: x.liquidity }); } catch { data.set(m.market, { mark: null, liq: null }); } }));
    let positions: ReturnType<GmxService['posView']>[] = [], pendingOrders: ReturnType<GmxService['orderView']>[] = [], positionsError: string | null = null;
    await this.refreshOpen().catch(() => {});
    const ops = await sql<Row[]>`select * from deriv_gmx_ops order by created_at desc limit 20`;
    if (me) {
      try {
        const [ps, os, api] = await Promise.all([this.deps.chain.positions(me), this.deps.chain.orders(me), this.deps.market.apiPositions(me).catch(() => null)]);
        positions = ps.map((p) => this.posView(p, data.get(gmxMarket(p.market)?.market ?? '')?.mark ?? null, data.get(gmxMarket(p.market)?.market ?? '')?.liq ?? null, api));
        pendingOrders = os.map((o) => this.orderView(o, ops));
      } catch (e) { positionsError = msg(e); }
    }
    let executionGas: string | null = null;
    try { executionGas = (await this.deps.chain.executionGas()).increase.toString(); } catch { executionGas = null; }
    return {
      venue: 'gmx' as const, network: GMX_PINS.network, chainId: GMX_PINS.chainId, settings, tradable: blockers.length === 0, blockers,
      blockerText: Object.fromEntries((Object.keys(GMX_BLOCKER_TEXT) as GmxBlocker[]).map((k) => [k, GMX_BLOCKER_TEXT[k][locale]])) as Record<GmxBlocker, string>,
      pins: { id: GMX_PINS.id, reviewedAt: GMX_PINS.id.slice(-10), ok: pins.ok, checkedAt: pins.checkedAt, problems: pins.problems, contracts: GMX_PINNED_CONTRACTS.map((c) => ({ name: c, address: GMX_PINS[c].address, explorer: this.explorer('addr', GMX_PINS[c].address) })) },
      account: me ? { address: me, explorer: this.explorer('addr', me) } : null, wallet, walletError,
      authorization: auth ? { id: auth.authorization.authorizationId, state: as!, policy: auth.authorization.policy, createdAt: auth.authorization.createdAt, expiresAt: auth.authorization.expiresAt, today: auth.today } : null,
      markets: GMX_MARKETS.map((m) => { const d = data.get(m.market); return { market: m.market, name: m.name, instrument: m.instrument, base: m.priceSymbol, indexDecimals: m.indexDecimals, collateral: m.collateral.map((c) => ({ token: c.token, symbol: c.symbol, decimals: c.decimals })),
        allowed: !!auth && as === 'active' && auth.authorization.policy.allowedMarkets.some((x) => lc(x) === lc(m.market)), mark: d?.mark ? rd(d.mark, 2) : null, oracleMin: d?.liq?.oracleMin ?? null, oracleMax: d?.liq?.oracleMax ?? null }; }),
      /** V11: the API-side loss limits and kill switch (new risk only); null without an authorization */
      risk,
      positions, positionsSource: 'chain' as const, positionsError, pendingOrders, operations: ops.map((r) => this.opView(r)),
      facts: { requestExpirationSec: GMX_REQUEST_EXPIRATION_SEC, executionGas, twoStep: true as const }, ts: this.now(),
    };
  }

  /** for the derivatives router: can a GMX order be prepared now, and the collateral the wallet holds on Arbitrum (never throws) */
  async tradability(): Promise<{ tradable: boolean; usdc: DecStr | null }> {
    try { const { me } = await this.gate(); return { tradable: true, usdc: await this.deps.chain.balances(me).then((b) => formatUnits(b.usdc, 6), () => null) }; } catch { return { tradable: false, usdc: null }; }
  }

  async operation(id: string) { let r = await this.row(id); if (!r.final) r = await this.refresh(r).catch(() => r); return { operation: this.opView(r) }; }

  // ------------------------------------------------------------------ authorization

  async prepareAuthorization(body: z.infer<typeof GmxAuthBodySchema>) {
    const { st, me } = await this.gate(false);
    const now = Math.floor(this.now() / 1000), ack = jurisdictionAck('gmx', body.locale);
    // the execution-fee ceiling of the policy: what fits under the wallet's own fee ceiling on Arbitrum, never above the hard bound
    const ceiling = BigInt(st.policy.maxFee[GMX_PINS.network] ?? '0'), maxExec = ceiling < GMX_POLICY_BOUNDS.maxExecutionFeeWei ? ceiling : GMX_POLICY_BOUNDS.maxExecutionFeeWei;
    if (maxExec === 0n) throw new UserError('policy', 'the wallet policy sets no fee ceiling for Arbitrum', 422);
    const markets = body.allowedMarkets.map((m) => { const p = gmxMarket(m); if (!p) throw new UserError('unknown_market', `${m} is not a market this wallet trades`, 422); return p.market; });
    const authorization: GmxAuthorization = { v: 1, authorizationId: randomUUID(), keyId: st.keyId, venue: 'gmx', network: 'arbitrum', account: lc(me), mode: 'MANUAL_LIVE', contracts: GMX_PINS.id, exchangeRouter: GMX_PINS.exchangeRouter.address,
      policy: { allowedMarkets: markets, maxLeverage: body.maxLeverage, maxOrderSizeUsd: D.str(D.from(body.maxOrderSizeUsd)), maxOrdersPerDay: body.maxOrdersPerDay, maxPriceDeviationBps: body.maxPriceDeviationBps, maxExecutionFeeWei: maxExec.toString() },
      createdAt: now, expiresAt: now + body.days * 86400, ackSha256: ack.sha256 };
    try { validateGmxAuthorization(authorization, now); } catch (e) { throw new UserError('bad_authorization', msg(e), 422); }
    const hash = gmxAuthorizationHash(authorization);
    await audit('deriv.gmx.authorization_prepared', 'owner', { id: authorization.authorizationId, hash: hex(hash), policy: authorization.policy, expiresAt: authorization.expiresAt });
    return { authorization, hash: hex(hash), ack, options: await this.options(hash, 300), maxExecutionFeeEth: formatUnits(maxExec, WEI) };
  }
  async approveAuthorization(body: z.infer<typeof GmxApproveAuthSchema>, locale: Locale = 'en') {
    await this.gate(false);
    const r = await this.deps.signer.gmxAuthorize(body.authorization, body.assertion); // the signer verifies the passkey over the same canonical bytes, the account, the contract set and the acknowledgement hash
    await audit('deriv.gmx.authorized', 'owner', { id: r.authorizationId, hash: r.hash, policy: body.authorization.policy, expiresAt: body.authorization.expiresAt, ackSha256: body.authorization.ackSha256 });
    // a new authorization, approved with the passkey, starts from the default loss limits and without a halt
    await this.writeRisk({ authorizationId: r.authorizationId, halt: null, ...gmxDefaultLimits(body.authorization.policy) });
    return this.status(locale);
  }
  /** stopping never needs a passkey, a server setting or a readable chain */
  async revoke(locale: Locale = 'en') {
    const st = await this.deps.signer.status(true);
    for (const a of st.gmx ?? []) if (!a.revoked) { await this.deps.signer.gmxRevoke(a.authorization.authorizationId); await audit('deriv.gmx.revoked', 'owner', { id: a.authorization.authorizationId }); }
    return this.status(locale);
  }

  // ------------------------------------------------------------------ V11: loss limits and kill switch (API side, new risk only)

  private async writeRisk(r: GmxRisk): Promise<void> { await sql`insert into settings (key, value) values (${GMX_RISK_KEY}, ${sql.json(r as never)}) on conflict (key) do update set value = excluded.value`; }
  /** the limits in force under this authorization: what was stored for it, else the defaults derived from its policy */
  private async risk(auth: GmxSignerAuth): Promise<GmxRisk> {
    const id = auth.authorization.authorizationId, stored = await getSetting<GmxRisk | null>(GMX_RISK_KEY, null);
    return stored && stored.authorizationId === id ? stored : { authorizationId: id, halt: null, ...gmxDefaultLimits(auth.authorization.policy) };
  }
  /**
   * Realised PnL of the orders THIS wallet executed (the keeper's own events: base PnL minus the position fee), today (UTC) and
   * in total. Not in it: a liquidation by GMX's keepers, funding and borrowing settled into collateral, and anything done to the
   * positions from another interface — the unrealised PnL of the open positions is added by the risk engine.
   */
  private async realized(now: number): Promise<{ today: DecStr; total: DecStr }> {
    const day = new Date(Math.floor(now / 86_400_000) * 86_400_000);
    const rows = await sql<{ pnl: string | null; fee: string | null; done_at: Date | null }[]>`select outcome->>'pnlUsd' as pnl, outcome->>'positionFeeUsd' as fee, done_at from deriv_gmx_ops where state = 'executed' and kind <> 'cancel' and outcome is not null`;
    let today = D.zero, total = D.zero;
    for (const r of rows) {
      let v: Dec;
      try { v = D.sub(D.from(r.pnl ?? '0'), D.from(r.fee ?? '0')); } catch { continue; }
      total = D.add(total, v);
      if (r.done_at && r.done_at >= day) today = D.add(today, v);
    }
    return { today: D.str(today), total: D.str(total) };
  }
  private async riskView(auth: GmxSignerAuth | null) {
    if (!auth) return null;
    const r = await this.risk(auth), used = await this.realized(this.now());
    return { halt: r.halt, maxDailyLoss: r.maxDailyLoss, maxTotalLoss: r.maxTotalLoss, defaults: gmxDefaultLimits(auth.authorization.policy), realizedToday: used.today, realizedTotal: used.total,
      note: 'Stops new positions only; closing and cancelling are never refused by these. Realised PnL counts this wallet\'s executed orders; a liquidation by GMX is not in it.' };
  }
  private async currentAuth(): Promise<GmxSignerAuth> {
    const auth = this.authOf(await this.deps.signer.status(true));
    if (!auth) throw new UserError('not_authorized', 'GMX trading is not authorized: there is no limit to change and nothing to halt', 409);
    return auth;
  }

  /** the kill switch: stops NEW GMX positions on this wallet. No passkey. It cancels nothing and closes nothing. */
  async halt(body: z.infer<typeof GmxHaltBodySchema>, locale: Locale = 'en') {
    const auth = await this.currentAuth(), r = await this.risk(auth);
    const text = `halted by the owner${body.reason ? `: ${body.reason}` : ''} (${new Date(this.now()).toISOString()})`;
    await this.writeRisk({ ...r, halt: text });
    for (const old of await sql<Row[]>`select * from deriv_gmx_ops where state = 'pending_approval' and kind = 'increase'`) await this.withdraw(old.id).catch(() => {});   // an increase under review ends here
    await audit('deriv.gmx.halt', 'owner', { authorizationId: r.authorizationId, reason: body.reason });
    return this.status(locale);
  }
  /** tightening is free; a higher loss limit needs the passkey (prepareRisk → approveRisk) */
  async setLimits(body: z.infer<typeof GmxLimitsBodySchema>, locale: Locale = 'en') {
    const auth = await this.currentAuth(), r = await this.risk(auth), next = { maxDailyLoss: D.str(D.from(body.maxDailyLoss)), maxTotalLoss: D.str(D.from(body.maxTotalLoss)) };
    const loosened = gmxLoosened(r, next);
    if (loosened.length) throw new UserError('passkey_required', `this change loosens ${loosened.join(', ')}: it needs the owner's passkey (prepare it, then approve). Tightening needs none.`, 403);
    await this.writeRisk({ ...r, ...next });
    await audit('deriv.gmx.limits', 'owner', { authorizationId: r.authorizationId, ...next, loosened: [], passkey: false });
    return this.status(locale);
  }
  /** step 1 of lifting the halt or loosening a limit: the canonical intent, stored once, and the WebAuthn request over its hash */
  async prepareRisk(kind: GmxRiskIntent['kind'], body: z.infer<typeof GmxLimitsBodySchema> | null = null) {
    const auth = await this.currentAuth(), r = await this.risk(auth);
    let limits: GmxRiskLimits | null = null, loosened: string[] = [], subject: string | null = null;
    if (kind === 'gmx-limits') {
      if (!body) throw new UserError('bad_request', 'the new limits are required', 400);
      limits = { maxDailyLoss: D.str(D.from(body.maxDailyLoss)), maxTotalLoss: D.str(D.from(body.maxTotalLoss)) };
      loosened = gmxLoosened(r, limits);
      if (!loosened.length) return { needed: false as const, kind, loosened, intent: null, hash: null, options: null, expiresAt: null };
    } else {
      if (r.halt === null) return { needed: false as const, kind, loosened, intent: null, hash: null, options: null, expiresAt: null };
      subject = r.halt;
    }
    if (!this.deps.verifyOwner) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval for a risk change: the change is refused', 503);
    const now = this.now(), intent: GmxRiskIntent = { v: 1, kind, authorizationId: r.authorizationId, limits, loosened, subject, nonce: randomUUID(), createdAt: now, expiresAt: now + RISK_INTENT_TTL_MS };
    const hash = gmxRiskIntentHash(intent);
    await sql`insert into settings (key, value) values (${`${GMX_RISK_PENDING}.${kind}`}, ${sql.json({ intent, hash: hex(hash) } as never)}) on conflict (key) do update set value = excluded.value`;
    await audit('deriv.gmx.risk_change_prepared', 'owner', { kind, hash: hex(hash), loosened });
    return { needed: true as const, kind, loosened, intent, hash: hex(hash), options: await this.options(hash, RISK_INTENT_TTL_MS / 1000), expiresAt: intent.expiresAt };
  }
  /** step 2: the prepared intent, taken once, must still describe the present state; the assertion must verify over its hash */
  async approveRisk(kind: GmxRiskIntent['kind'], assertion: unknown, locale: Locale = 'en') {
    const auth = await this.currentAuth(), r = await this.risk(auth), key = `${GMX_RISK_PENDING}.${kind}`;
    if (kind === 'gmx-resume' && r.halt === null) return this.status(locale);                 // nothing to lift
    const verify = this.deps.verifyOwner;
    if (!verify) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval for a risk change: the change is refused', 503);
    if (assertion === undefined || assertion === null) throw new UserError('passkey_required', 'this change needs the owner\'s passkey: prepare it first, then approve', 403);
    const stash = await getSetting<{ intent: GmxRiskIntent; hash: string } | null>(key, null);
    if (!stash) throw new UserError('bad_state', 'prepare this change first', 409);
    const i = stash.intent;
    if (hex(gmxRiskIntentHash(i)) !== stash.hash || i.kind !== kind) throw new UserError('bad_state', 'the prepared change is not this one', 409);
    if (this.now() >= i.expiresAt) { await sql`delete from settings where key = ${key}`; throw new UserError('expired', 'the approval window of this change has expired: prepare it again', 410); }
    if (i.authorizationId !== r.authorizationId || (kind === 'gmx-resume' && i.subject !== r.halt)) throw new UserError('bad_state', 'the authorization or the halt changed since this change was prepared: prepare it again', 409);
    try { await verify(assertion, Buffer.from(stash.hash, 'hex')); }
    catch (e) { await audit('deriv.gmx.risk_change_refused', 'owner', { kind, hash: stash.hash, reason: msg(e) }); throw new UserError('bad_approval', `the passkey approval of this change did not verify (${msg(e)}); nothing changed`, 403); }
    const taken = await sql`delete from settings where key = ${key} and value->>'hash' = ${stash.hash} returning key`;
    if (!taken.length) throw new UserError('bad_state', 'this change was already applied or replaced', 409);
    if (kind === 'gmx-resume') { await this.writeRisk({ ...r, halt: null }); await audit('deriv.gmx.resume', 'owner', { authorizationId: r.authorizationId, passkey: true }); }
    else { await this.writeRisk({ ...r, ...i.limits! }); await audit('deriv.gmx.limits', 'owner', { authorizationId: r.authorizationId, ...i.limits!, loosened: i.loosened, passkey: true }); }
    return this.status(locale);
  }

  // ------------------------------------------------------------------ pricing, fees, risk (estimates)

  private async compute(body: GmxOrderBody, me: string | null, auth: GmxSignerAuth | null, walletUsdc: bigint | null): Promise<Computed> {
    const pin = gmxMarket(body.market);
    if (!pin) throw new UserError('unknown_market', 'this market is not in the wallet\'s pinned GMX market table', 422);
    const c = pin.collateral[0]!, isLong = body.side === 'long', increase = body.action === 'increase', now = this.now();
    const md = await this.deps.market.market(pin.instrument), l = md.liquidity;
    if (!l) throw new UserError('venue_unreadable', 'GMX\'s market parameters could not be read: no price, no estimate', 503);
    if (now - l.ts > 30_000) throw new UserError('stale_data', 'GMX\'s market data is more than 30 s old', 503);
    const oMin = D.from(l.oracleMin), oMax = D.from(l.oracleMax), mid = D.div(D.add(oMin, oMax), D.from('2'), 18, 'half_even');
    // longs open at the oracle max and close at the min; shorts the other way round
    const reference = isLong === increase ? oMax : oMin;
    const acceptable = gmxAcceptablePrice(D.str(reference), body.slippageBps, { isLong, increase, indexDecimals: pin.indexDecimals });
    let amount = 0n, sizeRaw: bigint, leverage: DecStr | null = null, positions: GmxChainPosition[] = [], closing: GmxChainPosition | null = null;
    if (me) positions = await this.deps.chain.positions(me).catch(() => []);
    if (increase) {
      if (!body.collateral) throw new UserError('bad_order', 'an increase names the collateral sent', 422);
      try { amount = scaleExact(body.collateral, c.decimals); } catch { throw new UserError('bad_order', `a ${c.symbol} amount has at most ${c.decimals} decimals`, 422); }
      if (amount <= 0n) throw new UserError('bad_order', 'the collateral must be positive', 422);
      if ((body.leverage === undefined) === (body.sizeUsd === undefined)) throw new UserError('bad_order', 'give the leverage or the size, not both', 422);
      const size = body.sizeUsd !== undefined ? D.from(body.sizeUsd) : D.quantize(D.mul(D.from(body.collateral), D.from(body.leverage!)), D.from('0.01'), 'down');
      sizeRaw = gmxUsdToRaw(D.str(size));
      leverage = D.str(D.div(size, D.from(body.collateral), 2, 'half_even'));
    } else {
      const pos = positions.find((p) => lc(p.market) === lc(pin.market) && p.isLong === isLong && lc(p.collateralToken) === lc(c.token));
      if (!pos) throw new UserError('no_position', `the wallet holds no ${body.side} position on ${pin.name} (read on-chain)`, 422);
      sizeRaw = body.sizeUsd === undefined ? pos.sizeInUsd : gmxUsdToRaw(body.sizeUsd);
      if (sizeRaw > pos.sizeInUsd) sizeRaw = pos.sizeInUsd; // closing more than the position closes it
      closing = pos;
    }
    if (sizeRaw <= 0n) throw new UserError('bad_order', 'the size must be positive', 422);
    const sizeUsd = D.from(gmxUsdFromRaw(sizeRaw));
    // tokens: an increase buys size ÷ price; a decrease closes the same share of the position's tokens as of its USD size
    const tokens = closing ? D.from(unscale((closing.sizeInTokens * sizeRaw) / closing.sizeInUsd, pin.indexDecimals)) : D.div(sizeUsd, reference, pin.indexDecimals, 'down');

    // fees — every figure an estimate (ROUTER.md): price impact formula verified for decreases against the venue, ±100 %
    const oi = gmxBalanceOi(l), pi = l.priceImpact;
    const imp = gmxPriceImpact({ longOi: oi.long, shortOi: oi.short, sizeDeltaUsd: sizeUsd, isLong, increase, factorPositive: D.from(pi.factorPositive), factorNegative: D.from(pi.factorNegative), exponentPositive: D.from(pi.exponentPositive), exponentNegative: D.from(pi.exponentNegative), virtualInventoryUsd: oi.virtualUsd });
    const capPos = D.mul(sizeUsd, D.from(pi.maxFactorPositive)), capNeg = D.neg(D.mul(sizeUsd, D.from(pi.maxFactorNegative)));
    const impact = D.cmp(imp.impactUsd, capPos) > 0 ? capPos : D.cmp(imp.impactUsd, capNeg) < 0 ? capNeg : imp.impactUsd, capped = D.cmp(impact, imp.impactUsd) !== 0;
    const feeFactor = D.from(imp.balanceWasImproved ? l.positionFeeFactor.balanceImproved : l.positionFeeFactor.balanceNotImproved), positionFee = D.mul(sizeUsd, feeFactor);
    let base = 0n, tip = 1_000_000n, execGas: bigint | null = null, ethUsd: Dec | null = null;
    try { const g = await this.deps.chain.executionGas(); execGas = increase ? g.increase : g.decrease; } catch { execGas = null; }
    if (me) { try { const t = await this.deps.chain.txParams(me); base = t.baseFee; tip = t.tip; } catch { base = 0n; } }
    try { const e = pin.priceSymbol === 'ETH' ? mid : await this.deps.market.market(GMX_MARKETS.find((m) => m.priceSymbol === 'ETH')!.instrument).then((x) => (x.liquidity ? D.div(D.add(D.from(x.liquidity.oracleMin), D.from(x.liquidity.oracleMax)), D.from('2'), 18, 'half_even') : D.from(x.ticker.mark))); ethUsd = e; } catch { ethUsd = null; }
    const executionFee = execGas !== null && base > 0n ? gmxExecutionFee(execGas, base, tip) : 0n, maxFeePerGas = base * 2n + tip;
    const eth = (wei: bigint) => formatUnits(wei, WEI), usdOf = (wei: bigint) => (ethUsd ? D.str(D.div(D.mul(D.from(eth(wei)), ethUsd), D.one, 4, 'up')) : null);
    const gasMax = (FIXED_ORDER_GAS + (increase ? APPROVE_GAS : 0n)) * maxFeePerGas, gasExpected = EXPECTED_ORDER_GAS * (base + tip);
    const paysFunding = D.neg(D.from(isLong ? l.fundingRateLongPerHour : l.fundingRateShortPerHour)), paysBorrow = D.abs(D.from(isLong ? l.borrowingRateLongPerHour : l.borrowingRateShortPerHour));
    const perDay = (rate: Dec) => rd(D.mul(D.mul(sizeUsd, rate), D.from('24')));
    let liqPx: DecStr | null = null;
    if (increase && !D.isZero(tokens)) { try { const v = liquidationPriceIsolated({ side: body.side, size: tokens, entryPrice: reference, margin: D.sub(D.from(body.collateral!), positionFee), maintenanceFraction: D.from(l.minCollateralFactorForLiquidation), feeRate: D.from(l.positionFeeFactor.balanceNotImproved) }).value; liqPx = v ? rd(v, 2) : null; } catch { liqPx = null; } }
    const q = (d: Dec) => rd(d);
    const total = usdOf(executionFee) !== null && usdOf(gasExpected) !== null ? rd(D.add(D.add(positionFee, D.from(usdOf(executionFee)!)), D.from(usdOf(gasExpected)!)), 4) : null;
    const estimate = {
      source: 'estimate' as const, referencePrice: D.str(reference), oracleMin: l.oracleMin, oracleMax: l.oracleMax, acceptablePrice: gmxPriceFromRaw(acceptable, pin.indexDecimals), slippageBps: body.slippageBps,
      sizeUsd: D.str(sizeUsd), sizeTokens: D.str(tokens), collateral: increase ? D.str(D.from(body.collateral!)) : null, leverage,
      positionFee: { usd: q(positionFee), bps: D.str(D.mul(feeFactor, D.from('10000'))), balanceImproved: imp.balanceWasImproved },
      priceImpact: { usd: q(impact), uncertaintyUsd: q(D.abs(impact)), settledAt: 'close' as const, capped,
        note: 'recorded at the open, settled at the close, netted with the close impact and capped; the formula is verified against the venue for decreases only — count it as ±100 %' },
      executionFee: { eth: eth(executionFee), usd: usdOf(executionFee), sentWei: executionFee.toString(), note: 'sent with the order for GMX\'s keeper; the keeper keeps what the execution cost, the rest is refunded to the wallet (about a third came back on the fork proof)' },
      gas: { maxEth: eth(gasMax), expectedEth: eth(gasExpected), usd: usdOf(gasExpected) }, approval: increase,
      funding: { perHour: D.str(paysFunding), usdPerDay: perDay(paysFunding) }, borrow: { perHour: D.str(paysBorrow), usdPerDay: perDay(paysBorrow) },
      liquidationPrice: liqPx, liquidationNote: 'estimate: collateral minus the opening fee, closing fee counted; funding, borrowing, price impact and the liquidation fee are ignored; GMX liquidates on the oracle min/max',
      totalAtEntryUsd: total, notes: ['Today\'s funding and borrowing rates held constant: they change every second.', 'A market order executes at GMX\'s oracle price when the keeper runs, not at this reference: the acceptable price is the bound.'], ts: now,
    };

    // risk engine: account view = wallet collateral + on-chain positions
    let risk: Computed['risk'], signerWould: string | null = null;
    if (!auth || this.authState(auth) !== 'active') risk = { ok: false, code: 'not_authorized', reason: 'no active GMX authorization' };
    else {
      const pol = auth.authorization.policy, free = D.from(formatUnits(walletUsdc ?? 0n, 6));
      // every open position is valued (V11): the loss limits count the unrealised loss of ALL positions, not only this market's.
      // A market whose price cannot be read is an unknown loss: an increase is then refused rather than assumed fine.
      const marks = new Map<string, Dec | null>([[lc(pin.market), mid]]);
      for (const p of positions) {
        const k = lc(p.market), other = gmxMarket(p.market);
        if (marks.has(k)) continue;
        marks.set(k, other ? await this.deps.market.market(other.instrument).then((x) => (x.liquidity ? D.div(D.add(D.from(x.liquidity.oracleMin), D.from(x.liquidity.oracleMax)), D.from('2'), 18, 'half_even') : D.from(x.ticker.mark)), () => null) : null);
      }
      const unpriced = increase ? positions.find((p) => marks.get(lc(p.market)) === null) : undefined;
      const views = positions.map((p) => this.posView(p, marks.get(lc(p.market)) ?? null, null, null));
      const margin = views.reduce((s, v) => D.add(s, D.from(v.collateral)), D.zero);
      const account: AccountState = { venue: 'gmx', account: me ?? '', equity: D.str(D.add(free, margin)), collateral: D.str(D.add(free, margin)), freeCollateral: D.str(free), marginUsed: D.str(margin), maintenanceMargin: null, withdrawable: D.str(free), ts: now, source: 'venue' };
      // V11 (B-10): the configured loss limits and the kill switch (they were 1e9 and absent); a decrease is exempt from both (risk.ts)
      const lim = await this.risk(auth), used = await this.realized(now);
      const riskPolicy: RiskPolicy = { mode: 'MANUAL_LIVE', allowedInstruments: pol.allowedMarkets.flatMap((m) => (gmxMarket(m) ? [gmxMarket(m)!.instrument] : [])), halt: lim.halt, maxDataAgeMs: 30_000, maxDeviationBps: String(pol.maxPriceDeviationBps), maxMarkIndexBps: '100',
        maxLeverage: String(pol.maxLeverage), maxOrderNotional: D.str(D.mul(D.from(pol.maxOrderSizeUsd), D.from('1.1'))), maxGrossExposure: D.str(D.mul(D.from(pol.maxOrderSizeUsd), D.from(GMX_GROSS_MULTIPLE))), maxPositionNotional: D.str(D.mul(D.from(pol.maxOrderSizeUsd), D.from('2'))),
        minFreeCollateral: '0', minLiquidationDistanceBps: '200', maxDailyLoss: lim.maxDailyLoss, maxTotalLoss: lim.maxTotalLoss, maxOrdersPerMinute: 5, maxOrdersPerDay: pol.maxOrdersPerDay };
      const [{ count: lastMinute } = { count: 0 }] = await sql<{ count: number }[]>`select count(*)::int as count from deriv_gmx_ops where kind <> 'cancel' and state not in ('pending_approval', 'withdrawn', 'expired') and created_at > ${new Date(now - 60_000)}`;
      const r = checkOrder(riskPolicy, { instrument: pin.instrument, side: isLong === increase ? 'buy' : 'sell', type: 'market', size: D.str(tokens), price: gmxPriceFromRaw(acceptable, pin.indexDecimals), triggerPrice: null, reduceOnly: !increase, tif: 'ioc', clientId: randomUUID() },
        { instrument: md.instrument, account, positions: views.filter((v) => v.instrument).map((v): Position => ({ instrument: v.instrument!, side: v.side, size: v.sizeTokens, entryPrice: v.entryPrice, markPrice: v.markPrice ?? v.entryPrice, liquidationPrice: null, leverage: v.leverage ?? '1', marginMode: 'isolated', margin: v.collateral, unrealizedPnl: v.pnlUsd ?? '0', realizedPnl: null, fundingPaid: null, source: 'venue' })),
          openOrders: [], book: { instrument: pin.instrument, bids: [[l.oracleMin, '1000000000']], asks: [[l.oracleMax, '1000000000']], ts: l.ts }, ticker: { ...md.ticker, ts: Math.max(md.ticker.ts, l.ts) }, now,
          usage: { realizedToday: used.today, realizedTotal: used.total, ordersLastMinute: lastMinute, ordersToday: auth.today.increases }, ...(leverage ? { leverage } : {}), maintenanceMarginFraction: l.minCollateralFactorForLiquidation });
      risk = unpriced ? { ok: false, code: 'position_unpriced', reason: `the open position on ${gmxMarket(unpriced.market)?.name ?? unpriced.market} cannot be valued right now: its loss is unknown, so no new position is prepared (closing stays possible)` }
        : r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason };
      // what the signer would refuse, as far as it can be known here (its own price is not: the oracle mid stands in for it)
      try {
        const plan = { action: body.action, market: pin, collateral: c, amount, sizeDeltaUsd: sizeRaw, acceptablePrice: acceptable, executionFee, isLong, orderKey: null, gas: 0n, approveGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, nonce: 0, params: null };
        const v = gmxPolicyVerdict(pol as GmxPolicy, plan, { index: D.toNumber(mid), collateral: 1 });
        signerWould = v && v !== 'no price' ? v : null;
      } catch { signerWould = null; }
    }
    const gatePos: Position | null = closing ? { instrument: pin.instrument, side: isLong ? 'long' : 'short', size: unscale(closing.sizeInTokens, pin.indexDecimals), entryPrice: D.str(reference), markPrice: D.str(mid), liquidationPrice: null,
      leverage: '1', marginMode: 'isolated', margin: '0', unrealizedPnl: '0', realizedPnl: null, fundingPaid: null, source: 'venue' } : null;
    const gate: Computed['gate'] = { instrument: md.instrument, ticker: md.ticker, position: gatePos,
      req: { instrument: pin.instrument, side: isLong === increase ? 'buy' : 'sell', type: 'market', size: D.str(tokens), price: gmxPriceFromRaw(acceptable, pin.indexDecimals), triggerPrice: null, reduceOnly: !increase, tif: 'ioc', clientId: randomUUID() } };
    return { gate, pin, isLong, increase, amount, sizeRaw, acceptable, slippageBps: body.slippageBps, leverage, estimate, risk, signerWould, executionFee, base, tip };
  }

  async preview(body: GmxOrderBody) {
    let st = null as Awaited<ReturnType<GmxSignerPort['status']>> | null;
    try { st = await this.deps.signer.status(); } catch { st = null; }
    const me = st?.addresses[GMX_PINS.network] ?? null, auth = st ? this.authOf(st) : null;
    const usdc = me ? await this.deps.chain.balances(me).then((b) => b.usdc, () => null) : null;
    const c = await this.compute(body, me, auth, usdc), s = this.deps.settings(), blockers: GmxBlocker[] = [];
    if (!s.gmxLive) blockers.push('gmx_setting_off'); if (!s.liveMainnet) blockers.push('mainnet_setting_off');
    if (!auth) blockers.push('not_authorized'); else if (this.authState(auth) !== 'active') blockers.push(this.authState(auth) === 'stale' ? 'contracts_changed' : this.authState(auth) === 'expired' ? 'authorization_expired' : 'authorization_revoked');
    if (st?.halted) blockers.push('signer_halted');
    if ((await this.riskView(auth).catch(() => null))?.halt) blockers.push('gmx_halted');
    return { order: { market: c.pin.market, marketName: c.pin.name, side: body.side, action: body.action, collateral: c.estimate.collateral, sizeUsd: c.estimate.sizeUsd, acceptablePrice: c.estimate.acceptablePrice, slippageBps: c.slippageBps, leverage: c.leverage },
      estimate: c.estimate, risk: c.risk, blockers, signerWould: c.signerWould };
  }

  // ------------------------------------------------------------------ prepare (order, close, cancel) and approve

  private fieldsOf(i: Intent, pin: GmxMarketPin | null) {
    const g = i.gmx!, n = getNetwork(i.network), c = pin?.collateral.find((x) => x.token === g.collateralToken);
    const fields: { label: string; value: string }[] = [{ label: 'action', value: g.action }, { label: 'network', value: `${n.name} (${i.chainRef})` }];
    if (g.action !== 'cancel') fields.push({ label: 'market', value: `${pin!.name} — ${g.market}` }, { label: 'side', value: g.isLong ? 'long' : 'short' }, { label: 'orderType', value: g.orderType },
      { label: 'collateral', value: `${formatUnits(BigInt(i.amount), c!.decimals)} ${c!.symbol} (${g.collateralToken})` }, { label: 'sizeUsd', value: gmxUsdFromRaw(BigInt(g.sizeDeltaUsd)) },
      { label: 'acceptablePrice', value: gmxPriceFromRaw(BigInt(g.acceptablePrice), pin!.indexDecimals) }, { label: 'executionFee', value: `${formatUnits(BigInt(g.executionFee), WEI)} ETH` });
    else fields.push({ label: 'orderKey', value: g.orderKey! });
    fields.push({ label: 'maxFee', value: `${formatUnits(BigInt(i.maxFee), WEI)} ETH` }, { label: 'exchangeRouter', value: g.exchangeRouter }, { label: 'router', value: g.router }, { label: 'orderVault', value: g.orderVault }, { label: 'expiresAt', value: new Date(i.expiresAt * 1000).toISOString() });
    const fixed = g.action === 'cancel' ? [{ label: 'receiver', value: `${i.from} (collateral and fee return to the wallet: fixed when the order was created)` }] : [
      { label: 'receiver', value: i.from }, { label: 'cancellationReceiver', value: i.from }, { label: 'callbackContract', value: 'none (0x0)' }, { label: 'uiFeeReceiver', value: 'none (0x0)' }, { label: 'swapPath', value: 'empty' },
      { label: 'referralCode', value: 'none' }, { label: 'minOutputAmount', value: '0 (nothing is swapped)' }, { label: 'shouldUnwrapNativeToken', value: 'false' }];
    return { fields, fixed };
  }

  private async prepared(r: Row, intent: Intent, ttl: number) {
    const f = this.fieldsOf(intent, r.market ? gmxMarket(r.market) : null);
    // leverage is not a GMX field: it is size ÷ collateral, shown for the reader next to the two figures the passkey signs
    if (r.kind === 'increase' && typeof r.request.leverage === 'string') f.fields.splice(f.fields.findIndex((x) => x.label === 'sizeUsd') + 1, 0, { label: 'leverage', value: `${r.request.leverage}×` });
    return { operation: this.opView(r), intent, estimate: r.estimate, ...f, options: await this.options(intentHash(intent), ttl) };
  }

  /** one stored proposal + one operation row, waiting for the passkey. Nothing is signed. */
  private async store(o: { kind: Row['kind']; idem: string | null; me: string; st: Awaited<ReturnType<GmxSignerPort['status']>>; auth: GmxSignerAuth; g: Omit<GmxSection, 'venue' | 'authorizationId' | 'exchangeRouter' | 'router' | 'orderVault' | 'triggerPrice'>;
    asset: { id: string; symbol: string; decimals: number }; amount: bigint; gas: bigint | null; base: bigint; tip: bigint; nonce: number; row: Partial<Row> }) {
    const n = getNetwork(GMX_PINS.network), now = Math.floor(this.now() / 1000), proposalId = randomUUID(), maxFeePerGas = o.base * 2n + o.tip;
    const section: GmxSection = { venue: 'gmx-v2', authorizationId: o.auth.authorization.authorizationId, exchangeRouter: GMX_PINS.exchangeRouter.address, router: GMX_PINS.router.address, orderVault: GMX_PINS.orderVault.address, triggerPrice: '0', ...o.g };
    const build = (gas: bigint): Intent => IntentSchema.parse({ v: 1, proposalId, keyId: o.st.keyId, network: n.id, chainRef: n.chainRef, asset: o.asset.id, symbol: o.asset.symbol, decimals: o.asset.decimals, amount: o.amount.toString(), from: o.me, to: GMX_PINS.exchangeRouter.address,
      maxFee: ((gas + BigInt(section.approveGas)) * maxFeePerGas + BigInt(section.executionFee)).toString(), createdAt: now, expiresAt: now + TTL_SEC, policyVersion: o.st.policy.version, gmx: section,
      evm: { nonce: o.nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: o.tip.toString() } });
    let intent = build(o.gas ?? FIXED_ORDER_GAS), txs: ReturnType<typeof buildGmxTxs>;
    // the same rules and the same bytes as the signer, before the owner is asked
    try { txs = buildGmxTxs(intent, o.me); } catch (e) { throw new UserError('simulation_failed', msg(e), 422); }
    if (!txs.approve) {
      // no approval to wait for: the call can be simulated and its gas measured against the current state
      const call = { from: o.me, to: txs.main.to as string, data: txs.main.data as string, value: txs.main.value ?? 0n };
      const sim = await this.deps.chain.simulate(call);
      if (sim) throw new UserError(sim.unreachable ? 'chain_unreadable' : 'simulation_failed', sim.unreachable ? 'the transaction could not be simulated: Arbitrum did not answer' : `the transaction would revert now (${sim.error}); nothing was prepared`, sim.unreachable ? 503 : 422);
      const est = await this.deps.chain.estimateGas(call);
      if (est !== null) { const min = o.kind === 'cancel' ? GMX_GAS.cancelMin : GMX_GAS.orderMin, gas = (est * 13n) / 10n; intent = build(gas < min ? min : gas > FIXED_ORDER_GAS * 2n ? FIXED_ORDER_GAS * 2n : gas); try { txs = buildGmxTxs(intent, o.me); } catch (e) { throw new UserError('simulation_failed', msg(e), 422); } }
    }
    const spent = BigInt(o.st.spentToday[`${n.id}:${o.asset.symbol}`] ?? '0');
    // the signer's halt refuses an increase; a decrease or a cancellation is signed under halt (V11): the same rule is applied here
    const verdict = o.kind === 'increase' ? checkPolicy(o.st.policy, intent, spent, now, o.st.halted) : checkPolicyNoSpend(o.st.policy, intent, now, false);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const bal = await this.deps.chain.balances(o.me);
    if (bal.eth < BigInt(intent.maxFee)) throw new UserError('insufficient_gas', `the wallet holds ${formatUnits(bal.eth, WEI)} ETH on ${n.name}; gas and the execution fee can take up to ${formatUnits(BigInt(intent.maxFee), WEI)} ETH`, 422);
    const hash = intentHash(intent), opId = randomUUID(), created = new Date(this.now()), expires = new Date(intent.expiresAt * 1000);
    // one operation under review at a time: the previous unapproved one is withdrawn
    for (const old of await sql<Row[]>`select * from deriv_gmx_ops where state = 'pending_approval'`) await this.withdraw(old.id).catch(() => {});
    // the proposal row is the wallet's record and its per-network lock; its amount column must be positive: for a decrease or a cancellation it shows the native coin that may leave (fees)
    const shown = o.amount > 0n ? { asset: o.asset.id, symbol: o.asset.symbol, decimals: o.asset.decimals, amount: o.amount } : { asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals, amount: BigInt(intent.maxFee) };
    await sql`insert into proposals (id, idempotency_key, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, expires_at, created_at, updated_at)
      values (${proposalId}, ${`gmx-${opId}`}, 'pending_approval', 'gmx', ${n.id}, ${shown.asset}, ${shown.symbol}, ${shown.decimals}, ${shown.amount.toString()}, ${o.me}, ${GMX_PINS.exchangeRouter.address}, ${`GMX ${o.kind}`}, ${(EXPECTED_ORDER_GAS * (o.base + o.tip)).toString()}, ${intent.maxFee},
        ${sql.json(['gmx_order'])}, ${sql.json(intent as never)}, ${toHex(hash)}, ${expires}, ${created}, ${created})`;
    const [r] = await sql<Row[]>`insert into deriv_gmx_ops ${sql({ id: opId, idempotency_key: o.idem, kind: o.kind, state: 'pending_approval', account: lc(o.me), execution_fee: section.executionFee, max_fee: intent.maxFee, needs_approval: !!txs.approve,
      proposal_id: proposalId, op_hash: toHex(hash), request: sql.json({}), expires_at: expires, created_at: created, updated_at: created, ...o.row } as never)} returning *`;
    await this.log('prepared', r!, { proposal: proposalId, hash: toHex(hash), executionFee: section.executionFee, maxFee: intent.maxFee, approval: !!txs.approve }, 'owner');
    return this.prepared(r!, intent, TTL_SEC);
  }

  private async busy(exceptProposal?: string): Promise<void> {
    const [b] = await sql<{ id: string }[]>`select id from proposals where network = ${GMX_PINS.network} and id <> ${exceptProposal ?? '00000000-0000-0000-0000-000000000000'} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (b) throw new UserError('pending_tx', 'a previous transaction of the wallet on Arbitrum One is not confirmed yet; wait for it', 409);
  }
  private async again(idem: string | null) {
    if (!idem) return null;
    const [dup] = await sql<Row[]>`select * from deriv_gmx_ops where idempotency_key = ${idem}`;
    if (!dup) return null;
    const [p] = await sql<ProposalRow[]>`select * from proposals where id = ${dup.proposal_id}`;
    if (!p?.intent) throw new UserError('bad_state', 'this request was already made', 409);
    return dup.state === 'pending_approval' ? this.prepared(dup, p.intent, TTL_SEC) : { operation: this.opView(dup), intent: p.intent, estimate: dup.estimate, ...this.fieldsOf(p.intent, dup.market ? gmxMarket(dup.market) : null), options: null };
  }

  async prepareOrder(body: GmxOrderBody, idem: string) {
    const dup = await this.again(idem); if (dup) return dup;
    const { st, me, auth } = await this.gate(true, body.action === 'decrease');
    await this.busy();
    const bal = await this.deps.chain.balances(me), c = await this.compute(body, me, auth, bal.usdc), col = c.pin.collateral[0]!;
    if (!c.risk.ok) throw new UserError(`risk_${c.risk.code}`, c.risk.reason, 422);
    // V11: the unified risk engine (every venue of the live book, the owner's limits, the kill switch). A decrease is judged on the position read on-chain.
    if (this.preTrade) {
      const g = await this.preTrade({ mode: 'live', venue: 'gmx', network: GMX_PINS.network, accountId: me, req: { ...c.gate.req, clientId: idem.length >= 8 ? `gmx-${idem}`.slice(0, 100) : c.gate.req.clientId }, instrument: c.gate.instrument, origin: body.action === 'decrease' ? 'close' : 'owner',
        known: { ticker: c.gate.ticker, book: null, account: null, positions: c.gate.position ? [c.gate.position] : null, leverage: c.leverage } });
      if (!g.ok) throw new UserError(g.code, g.reason, g.code === 'risk_denied' ? 422 : 423);
    }
    // the signer's venue policy, applied before the owner is asked (the signer applies it again with its OWN price)
    if (c.signerWould) throw new UserError('venue_policy', c.signerWould, 422);
    if (c.executionFee === 0n) throw new UserError('chain_unreadable', 'the execution fee could not be computed (gas parameters or base fee unreadable)', 503);
    if (c.increase && bal.usdc < c.amount) throw new UserError('insufficient_collateral', `the wallet holds ${formatUnits(bal.usdc, col.decimals)} ${col.symbol} on Arbitrum One`, 422);
    const t = await this.deps.chain.txParams(me), needsApproval = c.increase && bal.usdcAllowance < c.amount;
    return this.store({ kind: body.action, idem, me, st, auth: auth!, asset: { id: col.token, symbol: col.symbol, decimals: col.decimals }, amount: c.amount, gas: null, base: t.baseFee, tip: t.tip, nonce: t.nonce,
      g: { action: body.action, market: c.pin.market, indexToken: c.pin.indexToken, collateralToken: col.token, orderType: c.increase ? 'MarketIncrease' : 'MarketDecrease', isLong: c.isLong, sizeDeltaUsd: c.sizeRaw.toString(), acceptablePrice: c.acceptable.toString(),
        executionFee: gmxExecutionFee((await this.deps.chain.executionGas())[c.increase ? 'increase' : 'decrease'], t.baseFee, t.tip).toString(), approveGas: needsApproval ? APPROVE_GAS.toString() : '0' },
      row: { market: c.pin.market, is_long: c.isLong, collateral_token: col.token, amount: c.amount.toString(), size_usd: c.sizeRaw.toString(), acceptable_price: c.acceptable.toString(), slippage_bps: c.slippageBps, estimate: sql.json(c.estimate as never) as never,
        request: sql.json({ leverage: c.leverage, body } as never) as never } });
  }

  async prepareClose(body: z.infer<typeof GmxCloseBodySchema>, idem: string) {
    const dup = await this.again(idem); if (dup) return dup;
    const { me } = await this.gate(true, true);
    const pin = gmxMarket(body.market), f = D.from(body.fraction);
    if (!pin) throw new UserError('unknown_market', 'this market is not in the wallet\'s pinned GMX market table', 422);
    if (D.isZero(f) || D.cmp(f, D.one) > 0) throw new UserError('bad_order', 'the fraction is above 0 and at most 1', 422);
    const pos = (await this.deps.chain.positions(me)).find((p) => lc(p.market) === lc(pin.market) && p.isLong === (body.side === 'long'));
    if (!pos) throw new UserError('no_position', `the wallet holds no ${body.side} position on ${pin.name} (read on-chain)`, 422);
    const size = D.cmp(f, D.one) === 0 ? pos.sizeInUsd : (pos.sizeInUsd * scaleExact(body.fraction, 18)) / 10n ** 18n;
    return this.prepareOrder({ market: pin.market, side: body.side, action: 'decrease', sizeUsd: gmxUsdFromRaw(size), slippageBps: body.slippageBps }, idem);
  }

  /** the owner cancels a still-pending order of this engine: possible for a market order only after GMX's request expiration */
  async prepareCancel(opId: string) {
    let target = await this.row(opId);
    if (!target.final) target = await this.refresh(target).catch(() => target);
    if ((target.state !== 'created' && target.state !== 'frozen') || !target.order_key) throw new UserError('bad_state', `the order is ${target.state}: there is nothing to cancel`, 409);
    const { st, me, auth } = await this.gate(true, true);
    await this.busy();
    const o = await this.deps.chain.order(target.order_key);
    if (!o) { await this.refresh(target).catch(() => {}); throw new UserError('bad_state', 'the order is no longer pending on-chain', 409); }
    if (lc(o.account) !== lc(me)) throw new UserError('bad_state', 'the order does not belong to this wallet', 409);
    const at = o.isFrozen ? 0 : o.updatedAtTime + GMX_REQUEST_EXPIRATION_SEC;
    if (Math.floor(this.now() / 1000) < at) throw new UserError('not_yet_cancellable', `GMX lets the account cancel a market order ${GMX_REQUEST_EXPIRATION_SEC} s after its creation: ${at - Math.floor(this.now() / 1000)} s left. Its keepers normally execute or cancel it before that.`, 409);
    const t = await this.deps.chain.txParams(me), n = getNetwork(GMX_PINS.network);
    return this.store({ kind: 'cancel', idem: null, me, st, auth: auth!, asset: { id: 'native', symbol: n.native.symbol, decimals: n.native.decimals }, amount: 0n, gas: 1_500_000n, base: t.baseFee, tip: t.tip, nonce: t.nonce,
      g: { action: 'cancel', market: ZERO_ADDRESS, indexToken: ZERO_ADDRESS, collateralToken: ZERO_ADDRESS, orderType: 'None', isLong: false, sizeDeltaUsd: '0', acceptablePrice: '0', executionFee: '0', approveGas: '0', orderKey: target.order_key },
      row: { order_key: target.order_key, target_op: target.id, market: target.market, is_long: target.is_long } });
  }

  /** before the passkey only: nothing was signed */
  async withdraw(opId: string) {
    let r = await this.row(opId);
    if (r.state !== 'pending_approval') throw new UserError('bad_state', `the operation is ${r.state}: it can no longer be withdrawn here`, 409);
    const [p] = await sql<ProposalRow[]>`select * from proposals where id = ${r.proposal_id}`;
    if (p && p.state === 'pending_approval') await move(p, 'rejected', { error: 'withdrawn by the owner' });
    r = await this.set(r, { state: 'withdrawn', final: true, done_at: new Date(this.now()), error: 'withdrawn before approval; nothing was signed' }, 'pending_approval');
    await this.log('withdrawn', r, {}, 'owner');
    return { operation: this.opView(r) };
  }

  /** The HTTP call is not the approval: the passkey assertion over the intent hash is, and only the signer judges it. */
  async approve(opId: string, assertion: unknown) {
    let r = await this.row(opId);
    await this.gate(true, r.kind !== 'increase');                                            // an exit is approved under halt and with the server settings off
    let [p] = await sql<ProposalRow[]>`select * from proposals where id = ${r.proposal_id}`;
    if (r.state !== 'pending_approval' || !p || p.state !== 'pending_approval' || !p.intent) throw new UserError('bad_state', `the operation is ${r.state}`, 409);
    if (p.expires_at && p.expires_at.getTime() < this.now()) { await this.refresh(r); throw new UserError('expired', 'approval window expired; start again', 410); }
    // V11: the global kill switch (an increase) or read-only mode (anything but a cancellation), engaged after the order was prepared
    const blk = this.newRiskBlock && r.kind !== 'cancel' ? await this.newRiskBlock() : null;
    if (blk && (r.kind === 'increase' || blk.code === 'read_only_mode')) { await this.withdraw(r.id).catch(() => {}); throw new UserError(blk.code, blk.reason, 423); }
    await this.busy(p.id);
    r = await this.set(r, { state: 'signed' }, 'pending_approval');
    p = await move(p, 'approved');
    let signed: Awaited<ReturnType<GmxSignerPort['sign']>>;
    try { signed = await this.deps.signer.sign(p.intent, assertion); }
    catch (e) {
      await move(p, 'failed', { error: msg(e) });
      r = await this.set(r, { state: 'failed', final: true, done_at: new Date(this.now()), error: `the signer refused: ${msg(e)}. Nothing was signed or sent.` });
      await this.log('refused', r, { error: msg(e) });
      throw e;
    }
    if (signed.hash !== p.intent_hash) { await move(p, 'failed', { error: 'signer hash mismatch' }); await this.set(r, { state: 'failed', final: true, error: 'signer hash mismatch; nothing was sent' }); throw new UserError('hash_mismatch', 'signer returned a different intent hash', 500); }
    p = await move(p, 'signed', { raw: signed.raw, txid: signed.txid, ...(signed.pre ? { pre_raw: signed.pre.raw, pre_txid: signed.pre.txid } : {}) });
    r = await this.set(r, { txid: signed.txid, pre_txid: signed.pre?.txid ?? null });
    await this.log('signed', r, { txid: signed.txid, hash: signed.hash, approval: signed.pre?.txid ?? null }, 'owner');
    await this.advanceSend(p).catch((e) => console.error(`[gmx] send ${r.id}: ${msg(e)}`));
    r = await this.refresh(await this.row(r.id)).catch(() => r);
    return { operation: this.opView(r) };
  }

  // ------------------------------------------------------------------ sending and tracking

  /**
   * After signing: mine the exact-amount approval if there is one, simulate the order transaction against the real state,
   * then relay it. Called right after the approval and by the wallet's worker for every signed `gmx` proposal (restart-safe).
   */
  async advanceSend(p: ProposalRow): Promise<ProposalRow> {
    if (p.state !== 'signed' || !p.raw || !p.intent || !p.txid) return p;
    const chain = this.deps.chain, s = this.deps.settings();
    const fail = (error: string) => move(p, 'failed', { error });
    // V11 (B-02): a signed decrease or cancellation still leaves when the server settings are switched off — only an increase is stopped
    if (p.intent.gmx?.action === 'increase' && (!s.gmxLive || !s.liveMainnet)) return fail('GMX trading was switched off on the server before the transaction left; nothing was sent');
    if (p.expires_at && this.now() - p.expires_at.getTime() > SEND_WINDOW_MS) return fail('the order could not be sent in time; nothing was sent');
    if (p.pre_raw && p.pre_txid && p.pre_state !== 'confirmed') {
      await chain.broadcast(p.pre_raw).catch(() => {});
      const rc = await chain.receipt(p.pre_txid);
      if (!rc) { if (p.pre_state !== 'sent') await sql`update proposals set pre_state = 'sent', updated_at = now() where id = ${p.id}`; return p; }
      if (!rc.ok) return fail('the token approval reverted; no order was created');
      await sql`update proposals set pre_state = 'confirmed', updated_at = now() where id = ${p.id}`;
      await audit('deriv.gmx.approval_confirmed', 'chain', { id: p.id, txid: p.pre_txid });
    }
    // last gate before the order leaves: pins again, and it must succeed against the current chain state
    const pins = await chain.checkPins(p.from_addr).catch(() => null);
    if (!pins) return p;
    if (!pins.ok) return fail(`GMX a publié de nouveaux contrats : nouvelle revue nécessaire (${pins.problems.join('; ').slice(0, 200)}); the order was not sent${p.pre_raw ? '. The exact-amount approval of the Router stays in place' : ''}`);
    const txs = buildGmxTxs(p.intent, p.from_addr);
    const sim = await chain.simulate({ from: p.from_addr, to: txs.main.to as string, data: txs.main.data as string, value: txs.main.value ?? 0n });
    if (sim?.unreachable) return p; // try again on the next tick
    if (sim) return fail(`the order transaction would revert now (${sim.error.slice(0, 120)}); it was not sent${p.pre_raw ? '. The exact-amount approval of the Router stays in place' : ''}`);
    try { await chain.broadcast(p.raw); } catch (e) { await sql`update proposals set error = ${'broadcast attempt failed: ' + msg(e).slice(0, 200)}, updated_at = now() where id = ${p.id}`; return p; }
    return move(p, 'broadcast', { broadcast_at: new Date(this.now()), last_broadcast_at: new Date(this.now()), error: null });
  }

  private transfersTo(rc: GmxReceipt, token: string, from: string, to: string): bigint {
    let sum = 0n;
    for (const l of rc.logs) { if (lc(l.address) !== lc(token)) continue; try { const ev = decodeEventLog({ abi: erc20Abi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }); if (ev.eventName === 'Transfer' && lc(ev.args.from) === lc(from) && lc(ev.args.to) === lc(to)) sum += ev.args.value; } catch { /* another event */ } }
    return sum;
  }

  /** what the keeper's (or the owner's) transaction did to the order, read from its own events */
  private async outcomeOf(r: Row, e: { event: GmxEvent; txid: string }): Promise<Record<string, unknown>> {
    const rc = await this.deps.chain.receipt(e.txid), pin = r.market ? gmxMarket(r.market) : null, c = pin?.collateral.find((x) => r.collateral_token && lc(x.token) === lc(r.collateral_token));
    const evs = (rc?.logs ?? []).map((l) => decodeGmxEvent(l)).filter((x): x is GmxEvent => !!x);
    const posEv = evs.find((x) => (x.eventName === 'PositionIncrease' || x.eventName === 'PositionDecrease') && typeof x.fields.orderKey === 'string' && lc(x.fields.orderKey) === r.order_key);
    const feeEv = evs.find((x) => x.eventName === 'PositionFeesCollected' && typeof x.fields.orderKey === 'string' && lc(x.fields.orderKey) === r.order_key);
    const refundEv = evs.find((x) => x.eventName === 'ExecutionFeeRefund' && lc(String(x.fields.receiver ?? '')) === r.account);
    const sUsd = (v: unknown) => (typeof v === 'bigint' ? (v < 0n ? `-${gmxUsdFromRaw(-v)}` : gmxUsdFromRaw(v)) : null);
    const out = rc && c ? this.transfersTo(rc, c.token, GMX_PINS.orderVault.address, r.account) + (pin ? this.transfersTo(rc, c.token, pin.market, r.account) : 0n) : null;
    const reasonBytes = typeof e.event.fields.reasonBytes === 'string' ? e.event.fields.reasonBytes : null, reason = typeof e.event.fields.reason === 'string' ? e.event.fields.reason : null;
    const cancelled = e.event.eventName === 'OrderCancelled';
    return { event: e.event.eventName, txid: e.txid, explorer: this.explorer('tx', e.txid),
      executionPrice: posEv && pin && typeof posEv.fields.executionPrice === 'bigint' ? gmxPriceFromRaw(posEv.fields.executionPrice, pin.indexDecimals) : null, sizeUsd: sUsd(posEv?.fields.sizeDeltaUsd),
      positionFeeUsd: feeEv && c && typeof feeEv.fields.positionFeeAmount === 'bigint' && typeof feeEv.fields['collateralTokenPrice.min'] === 'bigint' ? gmxUsdFromRaw(feeEv.fields.positionFeeAmount * (feeEv.fields['collateralTokenPrice.min'] as bigint)) : null,
      positionFeeAmount: feeEv && c && typeof feeEv.fields.positionFeeAmount === 'bigint' ? formatUnits(feeEv.fields.positionFeeAmount, c.decimals) : null,
      priceImpactUsd: sUsd(posEv?.fields.priceImpactUsd), pnlUsd: sUsd(posEv?.fields.basePnlUsd), collateralOut: out !== null && c ? formatUnits(out, c.decimals) : null,
      executionFeeRefundEth: refundEv && typeof refundEv.fields.refundFeeAmount === 'bigint' ? formatUnits(refundEv.fields.refundFeeAmount, WEI) : null,
      reason: cancelled || e.event.eventName === 'OrderFrozen' ? (reason || (reasonBytes ? GMX_ERROR_NAMES[reasonBytes.slice(0, 10)] ?? `error ${reasonBytes.slice(0, 10)}` : null)) : null, reasonCode: reasonBytes ? reasonBytes.slice(0, 10) : null,
      cancelledBy: cancelled ? ((await sql<{ id: string }[]>`select id from deriv_gmx_ops where kind = 'cancel' and txid = ${e.txid} limit 1`).length ? 'owner' : 'keeper') : null,
      // a cancelled increase: the collateral must have come back to the wallet in that very transaction
      collateralReturned: cancelled && r.kind === 'increase' && out !== null && r.amount !== null ? out === BigInt(r.amount) : null };
  }

  /** one reconciliation step of one operation; every state is in the database, so a restart continues exactly */
  async refresh(r: Row): Promise<Row> {
    if (r.final) return r;
    const now = this.now(), chain = this.deps.chain, stamp = { checked_at: new Date(now) };
    const [p] = r.proposal_id ? await sql<ProposalRow[]>`select * from proposals where id = ${r.proposal_id}` : [];
    if (r.state === 'pending_approval') {
      if (r.expires_at && r.expires_at.getTime() < now) {
        if (p && p.state === 'pending_approval') await move(p, 'expired', { error: 'approval window expired' }).catch(() => {});
        r = await this.set(r, { ...stamp, state: 'expired', final: true, done_at: new Date(now), error: 'approval window expired; nothing was signed' }, 'pending_approval');
        await this.log('expired', r);
      }
      return r;
    }
    if (r.state === 'signed') {
      let q = p;
      if (q && q.state === 'signed') q = await this.advanceSend(q);
      if (q && q.state === 'failed') { r = await this.set(r, { ...stamp, state: 'failed', final: true, done_at: new Date(now), error: q.error ?? 'the transaction was not sent' }); await this.log('failed', r, { error: r.error }); return r; }
      if (q && ['broadcast', 'confirming', 'finalized', 'reorged'].includes(q.state)) r = await this.set(r, { ...stamp, state: 'sent', sent_at: q.broadcast_at ?? new Date(now) });
      else return this.set(r, stamp);
    }
    if (r.state === 'sent' || (r.state === 'unknown' && !r.order_key)) {
      const rc = r.txid ? await chain.receipt(r.txid) : null;
      if (!rc) {
        if (p && (p.state === 'failed' || p.state === 'replaced')) { r = await this.set(r, { ...stamp, state: 'failed', final: true, done_at: new Date(now), error: p.error ?? `the transaction was ${p.state}` }); await this.log('failed', r, { error: r.error }); return r; }
        const since = r.sent_at?.getTime() ?? r.updated_at.getTime();
        return this.set(r, { ...stamp, ...(r.state === 'sent' && now - since > GMX_RECEIPT_OVERDUE_MS ? { state: 'unknown', error: 'the transaction was sent but no receipt was found: it is not known whether an order exists. Still looking.' } : {}) });
      }
      // the receipt is known: release the wallet's per-network lock now (its own worker would do the same from the same receipt a moment later)
      if (p && p.state === 'broadcast') await move(p, rc.ok ? 'confirming' : 'failed', rc.ok ? { confirmations: 1 } : { error: 'the transaction reverted on-chain' }).catch(() => {});
      if (!rc.ok) { r = await this.set(r, { ...stamp, state: 'failed', final: true, done_at: new Date(now), block_number: rc.blockNumber, error: `the transaction reverted on-chain: ${r.kind === 'cancel' ? 'the order was not cancelled by it' : 'no order was created'}; only gas was spent${r.needs_approval ? '. The exact-amount approval of the Router stays in place' : ''}` }); await this.log('reverted', r); return r; }
      const evs = rc.logs.map((l) => decodeGmxEvent(l)).filter((x): x is GmxEvent => !!x);
      if (r.kind === 'cancel') {
        const can = evs.find((x) => x.eventName === 'OrderCancelled' && gmxEventKey(x) === r.order_key);
        r = await this.set(r, { ...stamp, state: can ? 'done' : 'failed', final: true, done_at: new Date(now), block_number: rc.blockNumber, error: can ? null : 'the cancellation was mined but emitted no OrderCancelled event for the order' });
        await this.log(can ? 'cancel_mined' : 'cancel_without_event', r);
        if (r.target_op) await this.refresh(await this.row(r.target_op)).catch(() => {});
        return r;
      }
      const made = evs.find((x) => x.eventName === 'OrderCreated' && lc(String(x.fields.account ?? '')) === r.account);
      if (!made || !gmxEventKey(made)) { r = await this.set(r, { ...stamp, state: 'failed', final: true, done_at: new Date(now), block_number: rc.blockNumber, error: 'the transaction succeeded but emitted no OrderCreated event for this wallet: nothing to track' }); await this.log('no_order_event', r); return r; }
      // the event must carry exactly what was approved
      let diff: string[] = [];
      try { if (p?.intent) diff = gmxOrderCreatedDiff(made, verifyGmxIntent(p.intent, p.from_addr), p.from_addr); } catch (e) { diff = [msg(e)]; }
      r = await this.set(r, { ...stamp, state: 'created', order_key: gmxEventKey(made), block_number: rc.blockNumber, order_created_at: new Date(now), error: diff.length ? `the on-chain order differs from the approved one: ${diff.join('; ').slice(0, 240)}` : null,
        request: sql.json({ ...r.request, createGasUsed: rc.gasUsed.toString(), createGasPrice: rc.effectiveGasPrice.toString(), diff } as never) });
      await this.log(diff.length ? 'created_with_difference' : 'created', r, { diff });
    }
    if ((r.state === 'created' || r.state === 'frozen' || r.state === 'unknown') && r.order_key) {
      const o = await chain.order(r.order_key);
      if (o && !o.isFrozen) return this.set(r, { ...stamp, ...(r.state !== 'created' ? { state: 'created', error: null } : {}) });
      const events = await chain.orderEvents(r.order_key, Number(r.block_number ?? 0));
      const fin = events.find((e) => e.event.eventName === 'OrderExecuted') ?? events.find((e) => e.event.eventName === 'OrderCancelled');
      if (o?.isFrozen && !fin) {
        if (r.state === 'frozen') return this.set(r, stamp);
        const fr = events.find((e) => e.event.eventName === 'OrderFrozen');
        r = await this.set(r, { ...stamp, state: 'frozen', outcome: fr ? sql.json(await this.outcomeOf(r, fr) as never) : null, error: 'GMX froze the order: it could not be executed. It can be cancelled.' }); await this.log('frozen', r); return r;
      }
      if (!fin) {
        // gone from the order store, and no event found yet (log index lag): not assumed either way
        const attempts = r.attempts + 1;
        return this.set(r, { ...stamp, attempts, ...(attempts >= 6 && r.state !== 'unknown' ? { state: 'unknown', error: 'the order is no longer pending on-chain, but its OrderExecuted / OrderCancelled event was not found: outcome unknown. Still looking.' } : {}) });
      }
      const outcome = await this.outcomeOf(r, fin), executed = fin.event.eventName === 'OrderExecuted';
      r = await this.set(r, { ...stamp, state: executed ? 'executed' : 'cancelled', final: true, done_at: new Date(now), outcome: sql.json(outcome as never),
        error: executed ? null : `GMX cancelled the order${outcome.reason ? ` (${String(outcome.reason).slice(0, 120)})` : ''}${r.kind === 'increase' ? (outcome.collateralReturned === true ? '; the collateral came back to the wallet' : '; the return of the collateral could NOT be confirmed from the transaction — check the wallet balance') : ''}` });
      await this.log(executed ? 'executed' : 'cancelled', r, { outcome });
    }
    return r;
  }

  private async refreshOpen(): Promise<{ checked: number; errors: string[] }> {
    const rows = await sql<Row[]>`select * from deriv_gmx_ops where not final order by created_at`, errors: string[] = [];
    for (const r of rows) await this.refresh(r).catch((e) => { errors.push(`${r.id}: ${msg(e)}`); });
    return { checked: rows.length, errors };
  }
  /** the worker's pass: every operation in flight */
  step(): Promise<{ checked: number; errors: string[] }> { return this.refreshOpen(); }
}
