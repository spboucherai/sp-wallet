/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/live-adapter.ts
 * Module           : mm
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// LIVE `OrderPort` of the market-making engine over the quoting mandate — a separate adapter, NOT WIRED to anything: no
// module of the service imports it, and it holds no configuration. The integration step binds its three dependencies:
//
//   signer    `venueQuotingSign({ mandateId, sign })`  → POST /venue/quoting/sign of the isolated signer (one line to add to
//             services/api/src/signer-client.ts, next to `venueMandateSign`)
//   venue     `exchange(body, batchLength)` and `info(body)` → the existing Hyperliquid HTTP client (`HlHttp`), whose weight budget
//             is the IP budget of the engine
//   locks     the three mainnet settings, READ AT EVERY USE: `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET` and the new
//             `SPW_DERIV_MM_MAINNET` (default off). With any of them off on mainnet, quotes are refused here with a precise
//             code before anything is signed; cancels, reduce-only orders and the dead man's switch pass (they only reduce risk).
//
// It builds every action itself with the pinned asset table, asks the signer for the signature (the signer re-reads the action
// and enforces the mandate), sends it, and reads the venue's answer order by order. An answer that is lost or unreadable AFTER
// the action was sent is `unknown`, never a rejection.
import { D, hlPinnedAssets, createHlTrading, type HlL1SignPayload, type HlNetwork, type HlSignature, type SignRequest } from '@spw/derivatives/live';
import { HL_API, HL_WS, createHlNonceSource, hlAddressRateLimit, hlBatchAnswer, hlFills, hlFrontendOpenOrders, hlClearinghouseState, hlOrderLookup, hlStep, type HlTrading } from '@spw/derivatives/hyperliquid';
import type { Instrument } from '@spw/derivatives';
import type { AccountRead, BatchOutcome, CancelOutcome, OrderLookup, OrderPort, OrderResult, QuoteOrder, SwitchOutcome, VenueFill, VenueOpenOrder } from './ports.ts';

export const MM_MAINNET_LOCK = 'SPW_DERIV_MM_MAINNET';
export const MM_TESTNET_LOCK = 'SPW_DERIV_MM_TESTNET';
/**
 * The server settings that gate a QUOTE (the only thing a quoting session sends that can add risk). ONE rule, read at every use:
 *
 *   mainnet   SPW_DERIV_LIVE_MAINNET (any live order on mainnet)  →  `mainnet_disabled`
 *             SPW_DERIV_MANDATE_MAINNET (any order without a passkey on mainnet)  →  `mandate_mainnet_disabled`
 *             SPW_DERIV_MM_MAINNET (quoting on mainnet)  →  `mm_mainnet_disabled`
 *   testnet   SPW_DERIV_MM_TESTNET (quoting on testnet; the owner's own first step of the go-live checklist)  →  `mm_testnet_disabled`
 *   both      SPW_TRADING_API_EXECUTION — the switch that already gates every agent's NEW live risk in the order service
 *             (docs/v11/work/agents-bind.md): a market-making agent is an agent, its quotes are new live risk  →  `execution_disabled`
 *
 * Every one defaults to off, and anything but the exact value `on` is off. With any of them off: quotes are refused with the
 * first code above that applies, BEFORE anything is signed; cancels, reduce-only orders and the dead man's switch pass.
 * `mmTestnet` and `agentExecution` are optional in the interface for the callers that build their own locks (tests): absent
 * means "not consulted". `envMmLocks` — the only thing production uses — always provides all five.
 */
export interface MmLocks { /** SPW_DERIV_LIVE_MAINNET */ liveMainnet(): boolean; /** SPW_DERIV_MANDATE_MAINNET */ mandateMainnet(): boolean; /** SPW_DERIV_MM_MAINNET */ mmMainnet(): boolean;
  /** SPW_DERIV_MM_TESTNET */ mmTestnet?(): boolean; /** SPW_TRADING_API_EXECUTION */ agentExecution?(): boolean }
/** the settings from the process environment, each read when asked (never cached): `on` opens, anything else is closed */
export const envMmLocks = (env: Record<string, string | undefined>): Required<MmLocks> => ({ liveMainnet: () => env.SPW_DERIV_LIVE_MAINNET === 'on', mandateMainnet: () => env.SPW_DERIV_MANDATE_MAINNET === 'on', mmMainnet: () => env[MM_MAINNET_LOCK] === 'on',
  mmTestnet: () => env[MM_TESTNET_LOCK] === 'on', agentExecution: () => env.SPW_TRADING_API_EXECUTION === 'on' });
export interface MmLockRefusal { code: 'mainnet_disabled' | 'mandate_mainnet_disabled' | 'mm_mainnet_disabled' | 'mm_testnet_disabled' | 'execution_disabled'; message: string; setting: string }
/** why a quote cannot be sent on this network right now; null = every lock is open */
export function mmOpeningLock(network: HlNetwork, locks: MmLocks): MmLockRefusal | null {
  if (network === 'mainnet') {
    if (!locks.liveMainnet()) return { code: 'mainnet_disabled', setting: 'SPW_DERIV_LIVE_MAINNET', message: 'SPW_DERIV_LIVE_MAINNET is not on: no order that can add risk is sent to mainnet' };
    if (!locks.mandateMainnet()) return { code: 'mandate_mainnet_disabled', setting: 'SPW_DERIV_MANDATE_MAINNET', message: 'SPW_DERIV_MANDATE_MAINNET is not on: no order is placed without a passkey on mainnet' };
    if (!locks.mmMainnet()) return { code: 'mm_mainnet_disabled', setting: MM_MAINNET_LOCK, message: `${MM_MAINNET_LOCK} is not on: no quote is placed on mainnet` };
  } else if (locks.mmTestnet && !locks.mmTestnet()) return { code: 'mm_testnet_disabled', setting: MM_TESTNET_LOCK, message: `${MM_TESTNET_LOCK} is not on: no quote is placed on testnet` };
  if (locks.agentExecution && !locks.agentExecution()) return { code: 'execution_disabled', setting: 'SPW_TRADING_API_EXECUTION', message: 'SPW_TRADING_API_EXECUTION is not on: no agent places new live risk (cancels and reductions still pass)' };
  return null;
}
/** the network a session runs on is the venue account's, never a setting: the hosts, the asset table and the locks follow from it */
export function mmNetworkSelection(network: string, locks: MmLocks): { network: HlNetwork; restUrl: string; wsUrl: string; lock: MmLockRefusal | null; consulted: string[] } {
  if (network !== 'mainnet' && network !== 'testnet') throw new Error(`a quoting session runs on Hyperliquid mainnet or testnet, not on '${String(network).slice(0, 20)}'`);
  return { network, restUrl: HL_API[network], wsUrl: HL_WS[network], lock: mmOpeningLock(network, locks),
    consulted: network === 'mainnet' ? ['SPW_DERIV_LIVE_MAINNET', 'SPW_DERIV_MANDATE_MAINNET', MM_MAINNET_LOCK, 'SPW_TRADING_API_EXECUTION'] : [MM_TESTNET_LOCK, 'SPW_TRADING_API_EXECUTION'] };
}
export interface QuotingSignerPort { venueQuotingSign(p: { mandateId: string; sign: SignRequest }): Promise<{ signature: HlSignature; signer: string; kind: string; hash: string; mandateId: string; phase: string; orders: number }> }
export interface HlVenuePort { exchange(body: unknown, batchLength: number): Promise<unknown>; info(body: unknown): Promise<unknown> }
export interface LiveMmAdapterOptions {
  network: HlNetwork; account: string; mandateId: string;
  signer: QuotingSignerPort; venue: HlVenuePort; locks: MmLocks; now: () => number;
  /** validity of every signed action (nonce → venue expiry); the signer allows at most 30 s for a quote batch */
  actionTtlMs?: number;
}

const instrumentOf = (network: HlNetwork, id: string): Instrument => {
  const a = hlPinnedAssets(network).find((x) => `hyperliquid:${x.symbol}` === id);
  if (!a) throw new Error(`${id} is not in the pinned ${network} asset table`);
  return { venue: 'hyperliquid', symbol: a.symbol, id, base: a.symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0', lotSize: hlStep(a.szDecimals), minOrderSize: null, minNotional: '10',
    maxLeverage: String(a.maxLeverage), marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' };
};
type Refused = Extract<BatchOutcome, { kind: 'refused' }>;

export function createLiveMmAdapter(o: LiveMmAdapterOptions): OrderPort {
  const ttl = o.actionTtlMs ?? 10_000;
  const trading: HlTrading = createHlTrading({ network: o.network, assets: hlPinnedAssets(o.network), expiresAfterMs: ttl });
  const nonces = createHlNonceSource(o.now);
  const oidToClient = new Map<string, string>();
  const coinOf = (instrument: string) => instrument.slice(instrument.indexOf(':') + 1);

  /** the server locks: only what can add risk is stopped */
  const lockFor = (opening: boolean): Refused | null => {
    if (!opening) return null;
    const l = mmOpeningLock(o.network, o.locks);
    return l ? { kind: 'refused', stage: 'lock', code: l.code, message: l.message } : null;
  };
  /** sign (the signer enforces the mandate), then send. `refused` only when it is CERTAIN nothing reached the venue. */
  const send = async (built: { action: unknown; sign: SignRequest }, batch: number): Promise<{ ok: true; raw: unknown } | Refused | { kind: 'unknown'; message: string }> => {
    const payload = built.sign.payload as HlL1SignPayload;
    let signature: HlSignature;
    try { signature = (await o.signer.venueQuotingSign({ mandateId: o.mandateId, sign: built.sign })).signature; }
    catch (e) {
      // the signer said no, or could not be asked: either way no signature exists here, so nothing can have been sent
      const code = typeof (e as { code?: unknown }).code === 'string' ? `signer_${(e as { code: string }).code}` : 'signer_unreachable';
      return { kind: 'refused', stage: 'signer', code, message: String((e as Error).message).slice(0, 300) };
    }
    try { return { ok: true, raw: await o.venue.exchange({ action: built.action, nonce: payload.nonce, signature, vaultAddress: null, expiresAfter: payload.expiresAfter }, batch) }; }
    catch (e) { return { kind: 'unknown', message: `the venue did not answer (${String((e as Error).message).slice(0, 120)}): the action may have been taken` }; }
  };
  const orders = async (instrument: string, list: readonly QuoteOrder[], reduce: boolean): Promise<BatchOutcome> => {
    const lock = lockFor(!reduce);
    if (lock) return lock;
    const inst = instrumentOf(o.network, instrument);
    let built: ReturnType<HlTrading['buildOrders']>;
    try { built = trading.buildOrders(list.map((q) => ({ instrument: inst, req: { instrument, side: q.side, type: 'limit', size: q.size, price: q.price, triggerPrice: null, reduceOnly: reduce, tif: reduce ? 'ioc' : 'alo', clientId: q.clientId } })), { nonce: nonces.next() }); }
    catch (e) { return { kind: 'refused', stage: 'venue', code: 'not_buildable', message: String((e as Error).message).slice(0, 200) }; }   // off the grid: refused here, never rounded
    const r = await send(built, list.length);
    if (!('ok' in r)) return r;
    const a = hlBatchAnswer(r.raw, list.length);
    if (a.kind === 'unknown') return { kind: 'unknown', message: 'the venue\'s answer could not be read: the orders may exist' };
    if (a.kind === 'rejected') return { kind: 'refused', stage: 'venue', code: a.errorKind, message: a.error };
    const results = a.entries.map((e, k): OrderResult => {
      const clientId = list[k]!.clientId;
      if (e.outcome === 'resting') { oidToClient.set(e.oid, clientId); return { clientId, outcome: 'resting', venueOrderId: e.oid }; }
      if (e.outcome === 'filled') { oidToClient.set(e.oid, clientId); return { clientId, outcome: 'filled', venueOrderId: e.oid, size: e.totalSz, price: e.avgPx }; }
      if (e.outcome === 'error') return { clientId, outcome: 'rejected', code: e.kind, reason: e.error };
      return { clientId, outcome: 'rejected', code: 'unexpected_status', reason: 'the venue answered with a status a limit order does not have' };
    });
    return { kind: 'done', results };
  };

  return {
    actionTtlMs: ttl,
    submitQuotes: (instrument, quotes) => orders(instrument, quotes, false),
    submitReduces: (instrument, list) => orders(instrument, list, true),
    async cancel(instrument, clientIds): Promise<CancelOutcome> {
      if (!clientIds.length) return { kind: 'done', results: [] };
      const inst = instrumentOf(o.network, instrument);
      const r = await send(trading.buildCancels(clientIds.map((clientId) => ({ instrument: inst, clientId })), { nonce: nonces.next() }), clientIds.length);
      if (!('ok' in r)) return r;
      const a = hlBatchAnswer(r.raw, clientIds.length);
      if (a.kind === 'unknown') return { kind: 'unknown', message: 'the venue\'s answer to the cancel could not be read' };
      if (a.kind === 'rejected') return { kind: 'refused', stage: 'venue', code: a.errorKind, message: a.error };
      return { kind: 'done', results: a.entries.map((e, k) => ({ clientId: clientIds[k]!, outcome: e.outcome === 'success' ? 'cancelled' as const : 'gone' as const })) };
    },
    async scheduleCancel(timeMs): Promise<SwitchOutcome> {
      const r = await send(trading.buildScheduleCancel({ time: timeMs, nonce: nonces.next() }), 1);
      if (!('ok' in r)) return r;
      const raw = r.raw as { status?: unknown; response?: unknown } | null;
      if (raw && raw.status === 'ok') return { kind: 'done' };
      if (raw && raw.status === 'err' && typeof raw.response === 'string') return { kind: 'refused', stage: 'venue', code: 'schedule_cancel_refused', message: raw.response.slice(0, 200) };
      return { kind: 'unknown', message: 'the venue\'s answer to the scheduleCancel could not be read' };
    },
    async openOrders(instrument): Promise<VenueOpenOrder[]> {
      const coin = coinOf(instrument);
      return hlFrontendOpenOrders.parse(await o.venue.info({ type: 'frontendOpenOrders', user: o.account })).filter((x) => x.coin === coin).map((x) => {
        if (x.cloid) oidToClient.set(String(x.oid), x.cloid);
        return { clientId: x.cloid ?? null, venueOrderId: String(x.oid), side: x.side === 'B' ? 'buy' as const : 'sell' as const, price: x.limitPx, size: x.sz, reduceOnly: x.reduceOnly, timestamp: x.timestamp };
      });
    },
    async account(instrument): Promise<AccountRead> {
      const coin = coinOf(instrument), st = hlClearinghouseState.parse(await o.venue.info({ type: 'clearinghouseState', user: o.account }));
      const p = st.assetPositions.find((x) => x.position.coin === coin);
      return { position: p ? D.str(D.from(p.position.szi)) : '0', accountValue: st.marginSummary.accountValue, ts: st.time };
    },
    async fills(instrument, sinceMs): Promise<VenueFill[]> {
      const coin = coinOf(instrument);
      return hlFills.parse(await o.venue.info({ type: 'userFillsByTime', user: o.account, startTime: sinceMs })).filter((f) => f.coin === coin).map((f) => ({ id: `${f.hash}-${f.tid}`, clientId: f.cloid ?? oidToClient.get(String(f.oid)) ?? null, venueOrderId: String(f.oid),
        side: f.side === 'B' ? 'buy' as const : 'sell' as const, price: f.px, size: f.sz, fee: f.fee, ts: f.time, maker: f.crossed !== true }));
    },
    async lookup(_instrument, clientId): Promise<OrderLookup> {
      const r = hlOrderLookup(await o.venue.info({ type: 'orderStatus', user: o.account, oid: clientId }));
      if (!r.found) return 'not_found';
      return r.state === 'triggered' ? 'open' : r.state;
    },
    async addressRequestsRemaining(): Promise<number> { return hlAddressRateLimit(await o.venue.info({ type: 'userRateLimit', user: o.account })).remaining; },
  };
}
