/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/hyperliquid/trading.ts
 * Module           : venues
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-15
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

// Hyperliquid trading: builds actions, re-derives what a sign request does (`describe`), and submits signed actions.
// It never holds a key. Action shapes and field ORDER follow the official Python SDK (hyperliquid/utils/signing.py and
// hyperliquid/exchange.py, master 2fdb18f) and https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
import { keccak_256 } from '@noble/hashes/sha3.js';
import { z } from 'zod';
import type { DecStr } from '../../decimal.ts';
import { OrderRequestSchema, type Instrument, type OrderRequest } from '../../models.ts';
import { type SignRequest, type VenueTrading } from '../../venue.ts';
import { VenueError } from './error.ts';
import { hlFormatPrice, hlFormatSize, hlStep } from './format.ts';
import type { HlHttp } from './http.ts';
import { hlExchangeAnswer } from './schemas.ts';
import { buildApproveAgent, hlChainName, l1SignPayload, normalizeSignature, type HlApproveAgentAction, type HlNetwork, type HlSignature, type HlTypedData } from './signing.ts';

const ID = 'hyperliquid' as const;
const err = (code: ConstructorParameters<typeof VenueError>[1], message: string, detail: Record<string, unknown> = {}) => new VenueError(ID, code, message, detail);
const reject = (message: string, detail: Record<string, unknown> = {}) => err('rejected', message, detail);

/** one row of the venue's asset table (`meta.universe`): `asset` is the integer used in actions — it differs between networks */
export interface HlAsset { symbol: string; asset: number; szDecimals: number; maxLeverage: number; isolatedOnly: boolean; delisted: boolean }

// --- wire types ----------------------------------------------------------------------------------------------------------------
export type HlTif = 'Gtc' | 'Ioc' | 'Alo';
export type HlOrderTypeWire = { limit: { tif: HlTif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
/** key order is the SDK's `order_request_to_order_wire`: a, b, p, s, r, t, then c when present */
export interface HlOrderWire { a: number; b: boolean; p: string; s: string; r: boolean; t: HlOrderTypeWire; c?: string }
export interface HlOrderAction { type: 'order'; orders: HlOrderWire[]; grouping: 'na' }
export interface HlCancelAction { type: 'cancel'; cancels: { a: number; o: number }[] }
export interface HlCancelByCloidAction { type: 'cancelByCloid'; cancels: { asset: number; cloid: string }[] }
export interface HlUpdateLeverageAction { type: 'updateLeverage'; asset: number; isCross: boolean; leverage: number }
/** dead man's switch: cancel every open order of the account at `time` (unix ms); without `time`, remove the schedule. Key order of the SDK's `schedule_cancel`: type, then time when present */
export interface HlScheduleCancelAction { type: 'scheduleCancel'; time?: number }
export type HlL1Action = HlOrderAction | HlCancelAction | HlCancelByCloidAction | HlUpdateLeverageAction | HlScheduleCancelAction;

/** SignRequest.payload for kind 'hl_l1': everything needed to recompute the hash, plus the typed data that the key signs */
export interface HlL1SignPayload { scheme: 'l1'; action: unknown; nonce: number; vaultAddress: string | null; expiresAfter: number | null; typedData: HlTypedData }
/** SignRequest.payload for kind 'hl_user' (signed by the ACCOUNT key, e.g. approveAgent) */
export interface HlUserSignPayload { scheme: 'user'; action: unknown; typedData: HlTypedData }
export const HL_KIND_L1 = 'hl_l1', HL_KIND_USER = 'hl_user';

// --- client order id -----------------------------------------------------------------------------------------------------------
const CLOID = /^0x[0-9a-f]{32}$/;
/**
 * "Client Order ID (cloid) is an optional 128 bit hex string". Derived deterministically from the request's `clientId`:
 * the first 16 bytes of keccak256("spw/hyperliquid/cloid/v1:" ‖ clientId). A `clientId` that already is a cloid
 * (0x + 32 lower-case hex digits, as read back from the venue) is used unchanged.
 */
export function hlCloid(clientId: string): string {
  if (typeof clientId !== 'string' || clientId.length < 1 || clientId.length > 128) throw reject('clientId must be 1–128 characters');
  if (CLOID.test(clientId)) return clientId;
  const h = keccak_256(new TextEncoder().encode(`spw/hyperliquid/cloid/v1:${clientId}`));
  return `0x${Array.from(h.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// --- nonces ----------------------------------------------------------------------------------------------------------------------
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
//   "the 100 highest nonces are stored per address. Every new transaction must have nonce larger than the smallest nonce in this
//    set and also never have been used before."   "Nonces must be within (T - 2 days, T + 1 day)"   nonces are tracked per SIGNER.
export const HL_NONCE_PAST_MS = 2 * 86_400_000, HL_NONCE_FUTURE_MS = 86_400_000;
export function hlNonceInWindow(nonce: number, now: number): boolean {
  return Number.isSafeInteger(nonce) && nonce > now - HL_NONCE_PAST_MS && nonce < now + HL_NONCE_FUTURE_MS;
}
/** "fetch and increment an atomic counter … fast-forwarded to current unix milliseconds": unique, increasing, one per signer key */
export function createHlNonceSource(now: () => number = Date.now, last = 0): { next(): number } {
  let prev = last;
  return { next() { prev = Math.max(now(), prev + 1); return prev; } };
}

// --- strict schemas of what `describe` accepts (any extra field is a refusal) ------------------------------------------------------
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const wireDec = z.string().regex(/^(0|[1-9]\d*)(\.\d*[1-9])?$/); // no trailing zeros: exactly what is hashed
const orderWire = z.strictObject({
  a: uint, b: z.boolean(), p: wireDec, s: wireDec, r: z.boolean(),
  t: z.union([
    z.strictObject({ limit: z.strictObject({ tif: z.enum(['Gtc', 'Ioc', 'Alo']) }) }),
    z.strictObject({ trigger: z.strictObject({ isMarket: z.boolean(), triggerPx: wireDec, tpsl: z.enum(['tp', 'sl']) }) }),
  ]),
  c: z.string().regex(CLOID).optional(),
});
const orderAction = z.strictObject({ type: z.literal('order'), orders: z.array(orderWire).min(1).max(40), grouping: z.literal('na') });
const cancelAction = z.strictObject({ type: z.literal('cancel'), cancels: z.array(z.strictObject({ a: uint, o: uint })).min(1).max(40) });
const cancelByCloidAction = z.strictObject({ type: z.literal('cancelByCloid'), cancels: z.array(z.strictObject({ asset: uint, cloid: z.string().regex(CLOID) })).min(1).max(40) });
const updateLeverageAction = z.strictObject({ type: z.literal('updateLeverage'), asset: uint, isCross: z.boolean(), leverage: z.number().int().min(1).max(1000) });
const scheduleCancelAction = z.strictObject({ type: z.literal('scheduleCancel'), time: uint.optional() });
const approveAgentAction = z.strictObject({
  type: z.literal('approveAgent'), hyperliquidChain: z.enum(['Mainnet', 'Testnet']), signatureChainId: z.string().regex(/^0x[0-9a-f]{1,12}$/),
  agentAddress: z.string().regex(/^0x[0-9a-f]{40}$/), agentName: z.string().min(1).max(60).optional(), nonce: uint,
});
const typedData = z.strictObject({
  domain: z.strictObject({ name: z.string(), version: z.string(), chainId: z.number().int(), verifyingContract: z.string() }),
  types: z.record(z.string(), z.array(z.strictObject({ name: z.string(), type: z.string() }))),
  primaryType: z.string(), message: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
const l1Payload = z.strictObject({ scheme: z.literal('l1'), action: z.looseObject({ type: z.string() }), nonce: uint, vaultAddress: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(), expiresAfter: uint.nullable(), typedData });
const userPayload = z.strictObject({ scheme: z.literal('user'), action: z.looseObject({ type: z.string() }), typedData });

/** canonical JSON (sorted keys) — used to compare typed data structurally */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const sameKeys = (o: object, keys: string[]): boolean => { const k = Object.keys(o); return k.length === keys.length && k.every((x, i) => x === keys[i]); };

// --- options -------------------------------------------------------------------------------------------------------------------
export interface HlTradingOptions {
  network: HlNetwork;
  /** the venue's asset table for THIS network (meta.universe). `describe` trusts it to name instruments: it must come from the venue. */
  assets: HlAsset[];
  /** needed by `submit` only */
  http?: HlHttp;
  now?: () => number;
  /** sub-account or vault traded on behalf of; null = the account itself (the only mode used by the wallet) */
  vaultAddress?: string | null;
  /** when set, every L1 action carries `expiresAfter = nonce + expiresAfterMs` (the venue refuses it after that time) */
  expiresAfterMs?: number | null;
  /** `submit` refuses the mainnet exchange endpoint unless this is true (live trading is enabled by the owner, not by the build) */
  allowMainnetExchange?: boolean;
  /** V11 (market making): `describe` names a `scheduleCancel` action (`schedule_cancel`). Off by default: every caller that does
   *  not ask for it keeps reading that action as `other`, exactly as before — only the quoting mandate of the signer turns it on */
  describeScheduleCancel?: boolean;
  /** V11: with the mainnet endpoint closed (above), `submit` still sends what can only reduce risk — cancels, and order actions whose orders are all reduce-only */
  allowMainnetExits?: boolean;
}

export interface HlDescription { kind: 'order' | 'cancel' | 'leverage' | 'approve_agent' | 'schedule_cancel' | 'other'; orders?: OrderRequest[]; detail: Record<string, unknown> }

export interface HlTrading extends VenueTrading {
  buildOrder(req: OrderRequest, ctx: { instrument: Instrument; nonce: number }): { action: HlOrderAction; sign: SignRequest };
  buildCancel(o: { instrument: Instrument; venueOrderId?: string; clientId?: string; nonce: number }): { action: HlCancelAction | HlCancelByCloidAction; sign: SignRequest };
  /** set the leverage and the margin mode of one instrument (L1 action, signed by the API wallet) */
  buildUpdateLeverage(o: { instrument: Instrument; leverage: number; marginMode: 'cross' | 'isolated'; nonce: number }): { action: HlUpdateLeverageAction; sign: SignRequest };
  /** approveAgent: authorizes `agentAddress` as API wallet. The sign request is for the ACCOUNT key (kind 'hl_user'). */
  buildApproveAgent(o: { agentAddress: string; agentName: string | null; nonce: number; signatureChainId?: string }): { action: HlApproveAgentAction; sign: SignRequest };
  /** V11 (market making): several orders in ONE action. Every order is validated like `buildOrder`'s; nothing is rounded. */
  buildOrders(items: { req: OrderRequest; instrument: Instrument }[], ctx: { nonce: number }): { action: HlOrderAction; sign: SignRequest };
  /** V11: several cancels in ONE action — all by venue order id, or all by client id (the venue has one action type for each) */
  buildCancels(items: { instrument: Instrument; venueOrderId?: string; clientId?: string }[], ctx: { nonce: number }): { action: HlCancelAction | HlCancelByCloidAction; sign: SignRequest };
  /** V11: the venue's dead man's switch. `time` (unix ms): cancel every open order of the account then; null: remove the schedule */
  buildScheduleCancel(o: { time: number | null; nonce: number }): { action: HlScheduleCancelAction; sign: SignRequest };
  describe(sign: SignRequest): HlDescription;
  /** what `describe` returns for an order built from `req` (market → IOC limit, wire decimals, clientId → cloid) */
  normalizeRequest(req: OrderRequest, instrument: Instrument): OrderRequest;
}

export function createHlTrading(o: HlTradingOptions): HlTrading {
  const network = o.network, now = o.now ?? Date.now, vaultAddress = o.vaultAddress ? o.vaultAddress.toLowerCase() : null, expiresAfterMs = o.expiresAfterMs ?? null;
  if (vaultAddress !== null && !/^0x[0-9a-f]{40}$/.test(vaultAddress)) throw new Error('vaultAddress must be a 20-byte hex address');
  if (expiresAfterMs !== null && (!Number.isInteger(expiresAfterMs) || expiresAfterMs < 1000)) throw new Error('expiresAfterMs must be an integer of at least 1000');
  const bySymbol = new Map<string, HlAsset>(), byAsset = new Map<number, HlAsset>();
  for (const a of o.assets) {
    if (bySymbol.has(a.symbol) || byAsset.has(a.asset)) throw new Error(`asset table: duplicate entry ${a.symbol}/${a.asset}`);
    bySymbol.set(a.symbol, a); byAsset.set(a.asset, a);
  }

  const assetOf = (instrument: Instrument): HlAsset => {
    if (instrument.venue !== ID || instrument.id !== `${ID}:${instrument.symbol}`) throw reject('instrument is not a Hyperliquid instrument');
    const a = bySymbol.get(instrument.symbol);
    if (!a) throw reject(`instrument ${instrument.symbol} is not in the ${network} asset table`);
    if (instrument.lotSize !== hlStep(a.szDecimals)) throw reject(`instrument ${instrument.symbol}: lot size differs from the asset table (stale instrument?)`);
    return a;
  };
  const nonceOk = (nonce: number): number => { if (!Number.isSafeInteger(nonce) || nonce <= 0) throw reject('nonce must be a positive integer (unix milliseconds)'); return nonce; };
  const price = (x: DecStr | null, a: HlAsset, what: string): string => {
    if (x === null) throw reject(`${what} is required`);
    const r = hlFormatPrice(x, a.szDecimals);
    if (!r.ok) throw reject(`${what}: ${r.reason}`, { offTick: true });
    return r.wire;
  };
  const size = (x: DecStr, a: HlAsset): string => {
    const r = hlFormatSize(x, a.szDecimals);
    if (!r.ok) throw reject(r.reason, { offLot: true });
    return r.wire;
  };
  const l1 = <A extends HlL1Action>(action: A, nonce: number): { action: A; sign: SignRequest } => {
    const expiresAfter = expiresAfterMs === null ? null : nonce + expiresAfterMs;
    const { typedData: td } = l1SignPayload(action as never, { network, nonce, vaultAddress, expiresAfter });
    const payload: HlL1SignPayload = { scheme: 'l1', action, nonce, vaultAddress, expiresAfter, typedData: td };
    return { action, sign: { venue: ID, network, kind: HL_KIND_L1, payload } };
  };

  /** request → wire order (validated, never rounded) */
  const toWire = (input: OrderRequest, instrument: Instrument): HlOrderWire => {
    const parsed = OrderRequestSchema.safeParse(input);
    if (!parsed.success) throw reject(`malformed order request (${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message})`);
    const req = parsed.data, a = assetOf(instrument);
    if (req.instrument !== instrument.id) throw reject('order request and instrument differ');
    if (a.delisted || instrument.status === 'halted') throw reject(`${a.symbol} is delisted`);
    const s = size(req.size, a), p = price(req.price, a, req.type === 'market' ? 'price (worst acceptable price of a market order)' : 'price');
    let t: HlOrderTypeWire;
    if (req.type === 'limit' || req.type === 'market') {
      if (req.triggerPrice !== null) throw reject(`${req.type} orders take no trigger price`);
      // a market order is an aggressive limit: immediate-or-cancel, bounded by the request's worst price
      if (req.type === 'market' && req.tif !== 'ioc') throw reject('market orders are immediate-or-cancel: tif must be ioc');
      t = { limit: { tif: req.type === 'market' ? 'Ioc' : req.tif === 'gtc' ? 'Gtc' : req.tif === 'ioc' ? 'Ioc' : 'Alo' } };
    } else {
      if (req.tif !== 'gtc') throw reject('trigger orders have no time in force on Hyperliquid: tif must be gtc');
      const triggerPx = price(req.triggerPrice, a, 'triggerPrice');
      const isMarket = req.type === 'stop_market' || req.type === 'take_profit_market';
      t = { trigger: { isMarket, triggerPx, tpsl: req.type === 'stop_market' || req.type === 'stop_limit' ? 'sl' : 'tp' } };
    }
    return { a: a.asset, b: req.side === 'buy', p, s, r: req.reduceOnly, t, c: hlCloid(req.clientId) };
  };

  /** wire order → normalized request; refuses anything the builder could not have produced */
  const fromWire = (w: z.infer<typeof orderWire>): OrderRequest => {
    const a = byAsset.get(w.a);
    if (!a) throw reject(`order on asset ${w.a}, which is not in the ${network} asset table`);
    const keys = ['a', 'b', 'p', 's', 'r', 't', ...(w.c !== undefined ? ['c'] : [])];
    if (!sameKeys(w, keys)) throw reject('order fields are not in the canonical order');
    const p = hlFormatPrice(w.p, a.szDecimals), s = hlFormatSize(w.s, a.szDecimals);
    if (!p.ok || p.wire !== w.p) throw reject(`order price ${w.p} is not valid for ${a.symbol}`);
    if (!s.ok || s.wire !== w.s) throw reject(`order size ${w.s} is not valid for ${a.symbol}`);
    const base = { instrument: `${ID}:${a.symbol}`, side: w.b ? ('buy' as const) : ('sell' as const), size: w.s, price: w.p, reduceOnly: w.r, clientId: w.c ?? '' };
    if ('limit' in w.t) {
        return { ...base, type: 'limit', triggerPrice: null, tif: w.t.limit.tif === 'Gtc' ? 'gtc' : w.t.limit.tif === 'Ioc' ? 'ioc' : 'alo' };
    }
    const g = w.t.trigger;
    if (!sameKeys(g, ['isMarket', 'triggerPx', 'tpsl'])) throw reject('trigger fields are not in the canonical order');
    const tp = hlFormatPrice(g.triggerPx, a.szDecimals);
    if (!tp.ok || tp.wire !== g.triggerPx) throw reject(`trigger price ${g.triggerPx} is not valid for ${a.symbol}`);
    const type = g.tpsl === 'sl' ? (g.isMarket ? 'stop_market' : 'stop_limit') : g.isMarket ? 'take_profit_market' : 'take_profit_limit';
    return { ...base, type, triggerPrice: g.triggerPx, tif: 'gtc' };
  };

  const strict = <S extends z.ZodType>(schema: S, v: unknown, what: string): z.output<S> => {
    const r = schema.safeParse(v);
    if (!r.success) throw reject(`${what}: ${r.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 240));
    return r.data;
  };

  const describeL1 = (payload: unknown): HlDescription => {
    const p = strict(l1Payload, payload, 'sign payload');
    // zod rebuilds objects in schema order; the hash and the field-order checks must see the action AS GIVEN
    const raw = (payload as { action: Record<string, unknown> }).action;
    // 1. the typed data must be exactly the phantom agent of THIS action, nonce, vault and expiry, on THIS network
    let expected: HlTypedData;
    try { expected = l1SignPayload(raw as never, { network, nonce: p.nonce, vaultAddress: p.vaultAddress, expiresAfter: p.expiresAfter }).typedData; }
    catch (e) { throw reject(`action cannot be hashed (${(e as Error).message})`); }
    if (canon(expected) !== canon(p.typedData)) throw reject('typed data does not match the action (hash, network or domain differ)');
    const common = { nonce: p.nonce, vaultAddress: p.vaultAddress, expiresAfter: p.expiresAfter, connectionId: expected.message.connectionId };
    const list = (key: string): Record<string, unknown>[] => raw[key] as Record<string, unknown>[];
    // 2. what the action does
    switch (raw.type) {
      case 'order': {
        strict(orderAction, raw, 'order action');
        if (!sameKeys(raw, ['type', 'orders', 'grouping'])) throw reject('order action fields are not in the canonical order');
        return { kind: 'order', orders: list('orders').map((w) => fromWire(w as z.infer<typeof orderWire>)), detail: { ...common, grouping: 'na' } };
      }
      case 'cancel': {
        const a = strict(cancelAction, raw, 'cancel action');
        if (!sameKeys(raw, ['type', 'cancels']) || list('cancels').some((c) => !sameKeys(c, ['a', 'o']))) throw reject('cancel action fields are not in the canonical order');
        return { kind: 'cancel', detail: { ...common, cancels: a.cancels.map((c) => { const x = byAsset.get(c.a); if (!x) throw reject(`cancel on unknown asset ${c.a}`); return { instrument: `${ID}:${x.symbol}`, venueOrderId: String(c.o) }; }) } };
      }
      case 'cancelByCloid': {
        const a = strict(cancelByCloidAction, raw, 'cancelByCloid action');
        if (!sameKeys(raw, ['type', 'cancels']) || list('cancels').some((c) => !sameKeys(c, ['asset', 'cloid']))) throw reject('cancelByCloid action fields are not in the canonical order');
        return { kind: 'cancel', detail: { ...common, cancels: a.cancels.map((c) => { const x = byAsset.get(c.asset); if (!x) throw reject(`cancel on unknown asset ${c.asset}`); return { instrument: `${ID}:${x.symbol}`, clientId: c.cloid }; }) } };
      }
      case 'updateLeverage': {
        const a = strict(updateLeverageAction, raw, 'updateLeverage action');
        if (!sameKeys(raw, ['type', 'asset', 'isCross', 'leverage'])) throw reject('updateLeverage action fields are not in the canonical order');
        const x = byAsset.get(a.asset);
        if (!x) throw reject(`leverage change on unknown asset ${a.asset}`);
        if (a.leverage > x.maxLeverage) throw reject(`leverage ${a.leverage} above the maximum of ${x.symbol} (${x.maxLeverage})`);
        if (a.isCross && x.isolatedOnly) throw reject(`${x.symbol} is isolated-only`);
        return { kind: 'leverage', detail: { ...common, instrument: `${ID}:${x.symbol}`, leverage: String(a.leverage), marginMode: a.isCross ? 'cross' : 'isolated' } };
      }
      case 'scheduleCancel': {
        if (o.describeScheduleCancel !== true) return { kind: 'other', detail: { ...common, type: 'scheduleCancel' } };
        const a = strict(scheduleCancelAction, raw, 'scheduleCancel action');
        if (!sameKeys(raw, a.time === undefined ? ['type'] : ['type', 'time'])) throw reject('scheduleCancel action fields are not in the canonical order');
        return { kind: 'schedule_cancel', detail: { ...common, type: 'scheduleCancel', time: a.time ?? null } };
      }
      default:
        // a valid hash of something this module does not build (transfer between dexes, staking, sub-account, vault …): never sign
        return { kind: 'other', detail: { ...common, type: String(raw.type).slice(0, 60) } };
    }
  };

  const describeUser = (payload: unknown): HlDescription => {
    const p = strict(userPayload, payload, 'sign payload');
    if (p.action.type !== 'approveAgent') return { kind: 'other', detail: { type: p.action.type.slice(0, 60), primaryType: p.typedData.primaryType.slice(0, 80) } };
    const a = strict(approveAgentAction, p.action, 'approveAgent action');
    if (a.hyperliquidChain !== hlChainName(network)) throw reject(`approveAgent is for ${a.hyperliquidChain}, this is ${network}`);
    let expected: HlTypedData;
    try { expected = buildApproveAgent({ network, agentAddress: a.agentAddress, agentName: a.agentName ?? null, nonce: a.nonce, signatureChainId: a.signatureChainId }).typedData; }
    catch (e) { throw reject(`approveAgent: ${(e as Error).message}`); }
    if (canon(expected) !== canon(p.typedData)) throw reject('typed data does not match the approveAgent action');
    const m = /^(.*?)(?: valid_until (\d{13}))?$/.exec(a.agentName ?? '')!;
    return { kind: 'approve_agent', detail: { agentAddress: a.agentAddress, agentName: a.agentName === undefined ? null : m[1], validUntil: m[2] ? Number(m[2]) : null, nonce: a.nonce, signatureChainId: a.signatureChainId, hyperliquidChain: a.hyperliquidChain } };
  };

  return {
    buildOrder(req, ctx) {
      return l1({ type: 'order', orders: [toWire(req, ctx.instrument)], grouping: 'na' }, nonceOk(ctx.nonce));
    },

    buildCancel(c) {
      const a = assetOf(c.instrument), nonce = nonceOk(c.nonce);
      if ((c.venueOrderId === undefined) === (c.clientId === undefined)) throw reject('cancel needs exactly one of venueOrderId and clientId');
      if (c.venueOrderId !== undefined) {
        if (!/^(0|[1-9]\d{0,15})$/.test(c.venueOrderId) || !Number.isSafeInteger(Number(c.venueOrderId))) throw reject('venueOrderId must be the venue\'s numeric order id');
        return l1({ type: 'cancel', cancels: [{ a: a.asset, o: Number(c.venueOrderId) }] }, nonce);
      }
      return l1({ type: 'cancelByCloid', cancels: [{ asset: a.asset, cloid: hlCloid(c.clientId!) }] }, nonce);
    },

    buildOrders(items, ctx) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 40) throw reject('a batch holds 1 to 40 orders');
      const orders = items.map((x) => toWire(x.req, x.instrument)), ids = orders.map((w) => w.c);
      if (new Set(ids).size !== ids.length) throw reject('two orders of the batch carry the same client id');
      return l1({ type: 'order', orders, grouping: 'na' }, nonceOk(ctx.nonce));
    },

    buildCancels(items, ctx) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 40) throw reject('a batch holds 1 to 40 cancels');
      const byOid = items[0]!.venueOrderId !== undefined;
      for (const c of items) if ((c.venueOrderId === undefined) === (c.clientId === undefined) || (c.venueOrderId !== undefined) !== byOid) throw reject('a cancel batch is all by venueOrderId or all by clientId, exactly one per cancel');
      if (byOid) {
        for (const c of items) if (!/^(0|[1-9]\d{0,15})$/.test(c.venueOrderId!) || !Number.isSafeInteger(Number(c.venueOrderId))) throw reject('venueOrderId must be the venue\'s numeric order id');
        return l1({ type: 'cancel', cancels: items.map((c) => ({ a: assetOf(c.instrument).asset, o: Number(c.venueOrderId) })) }, nonceOk(ctx.nonce));
      }
      return l1({ type: 'cancelByCloid', cancels: items.map((c) => ({ asset: assetOf(c.instrument).asset, cloid: hlCloid(c.clientId!) })) }, nonceOk(ctx.nonce));
    },

    buildScheduleCancel(c) {
      const nonce = nonceOk(c.nonce);
      if (c.time !== null && (!Number.isSafeInteger(c.time) || c.time <= 0)) throw reject('scheduleCancel time must be unix milliseconds');
      return l1(c.time === null ? { type: 'scheduleCancel' } : { type: 'scheduleCancel', time: c.time }, nonce);
    },

    buildUpdateLeverage(u) {
      const a = assetOf(u.instrument), nonce = nonceOk(u.nonce);
      if (!Number.isInteger(u.leverage) || u.leverage < 1 || u.leverage > a.maxLeverage) throw reject(`leverage must be an integer between 1 and ${a.maxLeverage} for ${a.symbol}`);
      if (u.marginMode !== 'cross' && u.marginMode !== 'isolated') throw reject('marginMode must be cross or isolated');
      if (u.marginMode === 'cross' && a.isolatedOnly) throw reject(`${a.symbol} is isolated-only`);
      return l1({ type: 'updateLeverage', asset: a.asset, isCross: u.marginMode === 'cross', leverage: u.leverage }, nonce);
    },

    buildApproveAgent(g) {
      let built: ReturnType<typeof buildApproveAgent>;
      try { built = buildApproveAgent({ network, agentAddress: g.agentAddress, agentName: g.agentName, nonce: nonceOk(g.nonce), signatureChainId: g.signatureChainId }); }
      catch (e) { if (e instanceof VenueError) throw e; throw reject(`approveAgent: ${(e as Error).message}`); }
      const payload: HlUserSignPayload = { scheme: 'user', action: built.action, typedData: built.typedData };
      return { action: built.action, sign: { venue: ID, network, kind: HL_KIND_USER, payload } };
    },

    normalizeRequest(req, instrument) {
      return fromWire(toWire(req, instrument) as z.infer<typeof orderWire>);
    },

    describe(sign) {
      if (!sign || sign.venue !== ID) throw reject('sign request is not for Hyperliquid');
      if (sign.network !== network) throw reject(`sign request is for ${String(sign.network)}, this is ${network}`);
      if (sign.kind === HL_KIND_L1) return describeL1(sign.payload);
      if (sign.kind === HL_KIND_USER) return describeUser(sign.payload);
      throw reject(`unknown sign request kind '${String(sign.kind).slice(0, 40)}'`);
    },

    async submit(action, signature, nonce) {
      if (!o.http) throw err('unsupported', 'submit needs an http client');
      if (o.http.network !== network) throw err('unsupported', 'http client is for another network');
      const type = (action as { type?: unknown } | null)?.type;
      let batch = 1, isUser = false, exit = type === 'cancel' || type === 'cancelByCloid';
      if (type === 'order') { const orders = strict(orderAction, action, 'order action').orders; batch = orders.length; exit = orders.every((x) => x.r === true); }
      else if (type === 'cancel') batch = strict(cancelAction, action, 'cancel action').cancels.length;
      else if (type === 'cancelByCloid') batch = strict(cancelByCloidAction, action, 'cancelByCloid action').cancels.length;
      else if (type === 'updateLeverage') strict(updateLeverageAction, action, 'updateLeverage action');
      else if (type === 'scheduleCancel') { strict(scheduleCancelAction, action, 'scheduleCancel action'); exit = true; } // it can only cancel orders
      else if (type === 'approveAgent') { isUser = true; if (strict(approveAgentAction, action, 'approveAgent action').nonce !== nonce) throw reject('approveAgent: the nonce of the action and of the request differ'); }
      else throw err('unsupported', `action type '${String(type).slice(0, 40)}' is not submitted by this adapter`);
      // the mainnet lock stops NEW risk. With `allowMainnetExits`, what can only reduce it — a cancel, or orders that are ALL
      // reduce-only (read here from the action itself) — still leaves; everything else needs the lock open.
      if (network === 'mainnet' && o.allowMainnetExchange !== true && !(o.allowMainnetExits === true && exit)) {
        throw err('unsupported', o.allowMainnetExits === true ? 'the mainnet exchange endpoint is closed to new risk (allowMainnetExchange is not set): only cancels and reduce-only orders are sent' : 'the mainnet exchange endpoint is disabled (allowMainnetExchange is not set)');
      }
      if (!hlNonceInWindow(nonce, now())) throw reject('nonce is outside the venue\'s window (T − 2 days, T + 1 day)');
      let sig: HlSignature;
      try { sig = normalizeSignature(signature); } catch (e) { throw reject((e as Error).message); }
      // body as the SDK's `_post_action`; user-signed actions carry neither vault nor expiry
      const body = { action, nonce, signature: sig, vaultAddress: isUser ? null : vaultAddress, expiresAfter: isUser || expiresAfterMs === null ? null : nonce + expiresAfterMs };
      const raw = await o.http.exchange(body, batch);
      const parsed = hlExchangeAnswer.safeParse(raw);
      // an answer we cannot read is NOT a rejection: the order may exist. The caller must reconcile.
      if (!parsed.success) throw err('bad_answer', 'exchange: unexpected answer; the outcome is unknown until reconciled', { raw });
      const ans = parsed.data;
      if (ans.status === 'err') throw reject(ans.response.slice(0, 300), { raw });
      const ids: string[] = [], errors: string[] = [];
      for (const s of ans.response.data?.statuses ?? []) {
        if (typeof s === 'string') continue; // "success" (cancel), "waitingForFill" / "waitingForTrigger" (no order id yet)
        const x = s as { error?: string; resting?: { oid: number }; filled?: { oid: number } };
        if (typeof x.error === 'string') errors.push(x.error);
        else if (x.resting) ids.push(String(x.resting.oid));
        else if (x.filled) ids.push(String(x.filled.oid));
      }
      if (errors.length) throw reject(errors.join(' | ').slice(0, 300), { raw, venueOrderIds: ids, errors });
      return { accepted: true, venueOrderIds: ids, error: null, raw };
    },
  };
}
