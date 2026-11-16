// The spot engine's seam, seen from the order gateway (agent-runtime/gateway.ts): the paper book (a live KyberSwap quote, one
// transaction) and the vault's live swap (`placeLive`: order row, then the delegated signature under the signer's spot mandate).
import { createHash } from 'node:crypto';
import { formatUnits } from '@spw/core';
import { D } from '@spw/derivatives';
import type { CanonicalOrderInput } from '@spw/trading';
import { sql } from '../db.ts';
import type { OrderSeam, SeamResult } from '../agent-runtime/gateway.ts';
import type { EngineDeps, PlannedOrder } from './engine.ts';
import { feeCap, ORDER_TTL_MS } from './perp-gateway.ts';
import { agentAssets, cashOf, type AgentRow } from './routes.ts';

// ------------------------------------------------------------------------------------------------------------------ spot

/** deterministic id of a spot agent order: agent, mode, bar and its rank in the bar — two workers cannot both insert it */
export function spotClientOrderId(agentId: string, mode: string, bar: number, seq: number): string { return `sp-${agentId}-${mode === 'LIVE' ? 'l' : 'p'}-${Math.floor(bar / 1000)}-${seq}`; }
/** the row id (uuid-shaped) of a spot order, derived from its client id */
export function uuidFrom(text: string): string { const h = createHash('sha256').update(text).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }

interface SpotOrderRow { state: string; reason: string | null; amount_in: string; received: string | null; txid: string | null; from_symbol: string; to_symbol: string; aux: { usd?: number } | null }
export interface SpotSeam extends OrderSeam { plan(clientOrderId: string, o: PlannedOrder): void }
export function spotSeam(a: AgentRow, d: Pick<EngineDeps, 'quote' | 'placeLive'>, mode: 'PAPER' | 'LIVE', bar: number): SpotSeam {
  const plans = new Map<string, PlannedOrder>(), cash = cashOf(a);
  const decimalsOf = (symbol: string): number => agentAssets(a).find((x) => x.symbol === symbol)?.decimals ?? 18;
  const fromRow = (r: SpotOrderRow): SeamResult => {
    const sell = r.to_symbol === cash, asset = sell ? r.from_symbol : r.to_symbol, usd = r.aux?.usd ?? 0;
    if (r.state === 'filled') {
      const units = sell ? formatUnits(BigInt(r.amount_in), decimalsOf(asset)) : formatUnits(BigInt(r.received ?? '0'), decimalsOf(asset));
      const n = Number(units);
      return { status: 'accepted', venueOrderId: r.txid ?? 'simulated', filledSize: units, avgFillPrice: n > 0 && usd > 0 ? (usd / n).toFixed(8) : null, fills: [], final: true, note: mode === 'PAPER' ? 'simulated fill at the provider\'s live quote; nothing was signed' : null };
    }
    if (r.state === 'failed' || r.state === 'skipped') {
      const why = r.reason ?? r.state;
      if (/^refused by the signer/.test(why)) return { status: 'rejected', by: 'signer', code: 'signer_refused', reason: why };
      if (/reverted/.test(why)) return { status: 'rejected', by: 'venue', code: 'tx_reverted', reason: why };
      return { status: 'not_sent', code: 'not_sent', reason: why };
    }
    return { status: 'pending', code: r.state, reason: r.state === 'broadcast' ? 'broadcast, waiting for its receipt' : 'signed under the mandate, not broadcast yet', venueOrderId: r.state === 'broadcast' ? r.txid : null };
  };
  const row = async (clientOrderId: string): Promise<SpotOrderRow | null> =>
    (await sql<SpotOrderRow[]>`select state, reason, amount_in::text as amount_in, received::text as received, txid, from_symbol, to_symbol, aux from agent_orders where agent_id = ${a.id} and client_order_id = ${clientOrderId}`)[0] ?? null;
  return {
    plan(id, o) { plans.set(id, o); },
    async execute(order, ctx) {
      const o = plans.get(order.clientOrderId);
      if (!o) return { status: 'rejected', by: 'risk', code: 'not_planned', reason: 'the engine did not plan this order' };
      const ref = { clientOrderId: order.clientOrderId, signalId: ctx.signalId, configVersion: ctx.configVersion, strategySha256: ctx.strategySha256 };
      if (mode === 'LIVE') {
        // the order row exists before anything is signed; a refusal by the signer is recorded on it and thrown
        try { await d.placeLive(a, o, bar, ref); }
        catch (e) { const r = await row(order.clientOrderId); if (r) return fromRow(r); return { status: 'not_sent', code: 'not_prepared', reason: (e as Error).message.slice(0, 300) }; }
        return { status: 'pending', code: 'signed', reason: 'signed under the mandate; the engine broadcasts and follows it' };
      }
      // paper: fill at the provider's live quote for this exact size; nothing is signed
      let out: bigint;
      try { out = await d.quote(a, o.fromId, o.toId, o.amountIn); } catch (e) { return { status: 'not_sent', code: 'no_quote', reason: (e as Error).message.slice(0, 200) }; }
      const unitsIn = Number(formatUnits(o.amountIn, o.fromDecimals)), unitsOut = Number(formatUnits(out, o.toDecimals));
      await sql.begin(async (tx) => {
        await tx`insert into agent_orders (id, agent_id, mode, from_asset, to_asset, from_symbol, to_symbol, amount_in, expected_out, received, state, reason, bar, aux, client_order_id, signal_id, config_version, strategy_sha256)
          values (${uuidFrom(order.clientOrderId)}, ${a.id}, 'PAPER', ${o.fromId}, ${o.toId}, ${o.fromSymbol}, ${o.toSymbol}, ${o.amountIn.toString()}, ${out.toString()}, ${out.toString()}, 'filled', ${o.reason}, ${new Date(bar)}, ${tx.json({ usd: o.usd })},
            ${order.clientOrderId}, ${ctx.signalId}, ${ctx.configVersion}, ${ctx.strategySha256})`;
        await tx`insert into agent_paper (agent_id, symbol, units) values (${a.id}, ${o.fromSymbol}, ${-unitsIn}) on conflict (agent_id, symbol) do update set units = agent_paper.units + excluded.units`;
        await tx`insert into agent_paper (agent_id, symbol, units) values (${a.id}, ${o.toSymbol}, ${unitsOut}) on conflict (agent_id, symbol) do update set units = agent_paper.units + excluded.units`;
      });
      return fromRow((await row(order.clientOrderId))!);
    },
    async lookup(order) { const r = await row(order.clientOrderId); return r ? fromRow(r) : null; },
    // paper: one local transaction. live: a prepared row that was never signed is failed by the engine after three minutes
    absenceConclusiveAt: (_o, submittedAt) => (mode === 'PAPER' ? submittedAt : submittedAt + 180_000),
  };
}

/** the canonical order of a planned spot swap: a sale of the asset for the cash leg, or a purchase with it */
export function spotCanonical(a: AgentRow, o: PlannedOrder, mode: 'PAPER' | 'LIVE', clientOrderId: string, authorityId: string, now: number): CanonicalOrderInput {
  const sell = o.toSymbol === cashOf(a), symbol = sell ? o.fromSymbol : o.toSymbol;
  const amount = formatUnits(o.amountIn, o.fromDecimals);
  return { v: 1, venue: 'kyberswap', network: a.network, instrument: `kyberswap:${symbol}`, marketKind: 'spot', side: sell ? 'sell' : 'buy', type: 'market', size: sell ? amount : null, notional: sell ? null : amount, limitPrice: null, triggerPrice: null,
    reduceOnly: false, tif: 'ioc', maxSlippageBps: a.risk.slippageBps, maxFeeUsd: feeCap(D.from(Math.max(o.usd, 0.01).toFixed(6))), leverage: null, marginMode: null, clientOrderId, mode: mode === 'LIVE' ? 'live' : 'paper',
    principal: { kind: 'agent', id: a.id }, mandateId: authorityId, createdAt: now, expiresAt: now + ORDER_TTL_MS };
}
