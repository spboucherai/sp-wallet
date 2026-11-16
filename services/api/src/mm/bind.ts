// Composition of the LIVE side of market making on the execution layer of a process: the ports of mm/runtime.ts bound to the
// real services. Nothing here decides anything; it only says which service answers which port.
//
//   signer        the signer's QUOTING endpoints (`/venue/quoting/sign`, its status) — the only signing path a session has
//   venue         the process's Hyperliquid HTTP client of the account's network (LiveVenues): its sliding weight window IS the
//                 process's share of the venue's IP limit, whoever spends it (the session, the risk engine's reads, the live engine)
//   user feed     the `account` subscription of that client's WebSocket (orderUpdates, userFills, userEvents)
//   mandate       the mandate service: the agent's quoting mandate, usable only if active, in its active phase and intact
//   risk          the unified risk service (`evaluateOrder`, recorded like any decision, as a preview: a quote is not an order row)
//   books         mainnet: the stream engine's own market state; testnet: the testnet client's `l2Book` stream
import { hlStep, type Book, type HlNetwork } from '@spw/derivatives';
import { hlPinnedAssets, type VenueQuotingMandate } from '@spw/derivatives/live';
import type { StreamMmOptions } from '../agent-runtime/stream-engine.ts';
import type { Execution } from '../orders/index.ts';
import { envMmLocks } from './live-adapter.ts';
import { subscribingBookSource, type BookSource } from './market-data.ts';
import { MmRuntime, type MmLiveDeps, type QuotingMandateInfo } from './runtime.ts';
import type { UserFeedEvent } from './user-stream.ts';

export function mmLiveDeps(ex: Execution): MmLiveDeps {
  const venues = () => ex.live().deps.venues;
  return {
    signer: ex.quotingSigner as MmLiveDeps['signer'],
    venue: (network) => { const h = venues().get(network).adapter.http; return { info: (b) => h.info(b as { type: string }), exchange: (b, n) => h.exchange(b as Record<string, unknown>, n), processUsed: () => h.budget.used() }; },
    userFeed: (network) => ({ subscribe: (account, on, onStatus) => venues().get(network).adapter.stream({ type: 'account', account }, (ev) => on(ev as UserFeedEvent), onStatus) }),
    async mandate(agentId): Promise<QuotingMandateInfo | null> {
      const q = await ex.mandates.quotingFor(agentId);
      if (!q || !q.row.signer || !q.row.compiled?.venue || !q.row.quoting) return null;
      const vm = q.row.compiled.venue.mandate as VenueQuotingMandate, usable = q.row.state === 'active' && q.phase === 'active' && q.integrity === null;
      return { mandateId: q.row.id, accountId: q.row.signer.accountId, account: vm.account, network: vm.network, section: q.row.quoting.section, usable, why: q.integrity ?? (usable ? null : `the mandate is ${q.row.state === 'active' ? q.phase : q.row.state}`), phase: String(q.phase),
        expiresAtMs: q.row.mandate.notAfter * 1000, maxDailyLossUsd: q.row.mandate.maxDailyLossUsd, maxPositionNotionalUsd: q.row.mandate.maxPositionNotionalUsd };
    },
    revoke: async (mandateId, detail) => { await ex.mandates.revoke(mandateId, { by: 'system', reason: 'stop_condition', detail, cancelOpenOrders: false }); },
    async evaluate(order, accountId) { const ev = await ex.risk.evaluateOrder(order, { accountId, preview: true }); return { allow: ev.decision === 'allow', code: ev.code, message: ev.reason }; },
    setStepPacing: (accountId, everyMs) => ex.live().setStepPacing(accountId, everyMs),
  };
}
/** top of book of a network from the process's own Hyperliquid client of that network (its `l2Book` stream) */
export function venueBookSource(ex: Execution, network: HlNetwork): BookSource & { close(): void } {
  return subscribingBookSource((symbol, onBook, onStatus) => ex.live().deps.venues.get(network).adapter.stream({ type: 'book', symbol }, (ev) => { const e = ev as { type?: string; book?: Book }; if (e.type === 'book' && e.book) onBook(e.book); }, onStatus), () => ex.live().now());
}
/** what the stream engine of a worker process is given: live sessions on the execution layer, testnet books from the testnet client */
export function mmStreamOptions(ex: Execution, worker: string): StreamMmOptions {
  let testnet: (BookSource & { close(): void }) | null = null;
  return { live: mmLiveDeps(ex), worker, locks: () => envMmLocks(process.env), books: (network) => (network === 'testnet' ? (testnet ??= venueBookSource(ex, 'testnet')) : null) };
}
/** a runtime of its own for the owner's "pull" / "flatten" when no worker runs the agent's session: books from the venue clients, nothing else */
export function standaloneMm(ex: Execution): MmRuntime {
  const sources = new Map<HlNetwork, BookSource>();
  return new MmRuntime({ now: () => ex.live().now(), worker: `owner-command:${process.pid}`, locks: () => envMmLocks(process.env), live: mmLiveDeps(ex),
    books: (network) => { let s = sources.get(network); if (!s) { s = venueBookSource(ex, network); sources.set(network, s); } return s; },
    resolve: async (venue, base) => (venue === 'hyperliquid' ? { venue: 'hyperliquid', symbol: base, id: `hyperliquid:${base}`, base, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0', lotSize: lotOf(base), minOrderSize: null, minNotional: '10',
      maxLeverage: '1', marginModes: ['cross'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' } : null),
    fees: () => null, killSwitch: async () => { const s = await ex.risk.switches(); return s.killSwitch.on || s.readOnly.on; } });
}
const lotOf = (base: string): string => { const a = [...hlPinnedAssets('mainnet'), ...hlPinnedAssets('testnet')].find((x) => x.symbol === base); if (!a) throw new Error(`${base} is not in the pinned asset table`); return hlStep(a.szDecimals); };
