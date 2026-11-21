/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/routes.ts
 * Module           : agents
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

// Trading agents (V3): lifecycle, vaults, mandates. The engine that trades is in engine.ts; nothing here signs anything
// except through the signer's mandate endpoints.
import { getWithdrawal, listWithdrawals, requestWithdrawal } from './withdrawals.ts'; // v8
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { hexToBigInt, hexToNumber } from 'viem';
import { z } from 'zod';
import { NETWORKS, cashLegs, CASH_SYMBOLS, formatUnits, getAsset, getNetwork, hasSignerPrice, IntentSchema, MANDATE_NETWORKS, mandateHash, MandateSchema, MAX_AGENT_SYMBOLS, parseUnits, resolveAgentAssets, toB64u, toHex, tradableSymbols, validateMandate, vaultKeyId, type AgentAsset, type Mandate, type NetworkDef } from '@spw/core';
import { listCreds } from '../auth.ts';
import { adapterFor } from '../chains/index.ts';
import { rpcAny, rpcQuorum } from '../chains/rpc.ts';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { getSeries } from '../market/series.ts';
import { listQuality } from '../market/store.ts';
import { FEE_WARN_SHARE, feeShare, FLOOR_ORDERS, gasReserve, RESERVE_ORDERS, type GasReserve } from './gas.ts';
import { signer } from '../signer-client.ts';
import { revokeAgentMandate } from './live.ts'; // V11 (D2): leaving LIVE revokes the mandate at the signer
// >>> v6 perp agents: the shared routes delegate to perp-routes.ts when the agent's kind is 'perp'
import { assertPerpApprovable, createPerpAgent, isPerp, perpDetail, perpMode, perpView, spotOnly } from './perp-routes.ts';
// <<< v6 perp agents
import { paperBookView } from './paper-view.ts'; // v8 hardening: read-only view of the paper book

export interface AgentRow {
  id: string; name: string; mission: string; state: string; mode: string; network: string; universe: string[]; interval: string;
  /** cash leg symbol (USDC unless the owner chose USDT) and the registry asset chosen for each market symbol; null/empty on agents created before V5 */
  cash: string | null; assets: Record<string, string> | null;
  risk: Risk; vault_index: number; vault_address: string; capital_usdc: string; strategy_version_id: string | null; mandate_id: string | null; mandate: Mandate | null;
  last_bar: Date | null; stop_reason: string | null; created_at: Date; updated_at: Date;
  /** v6: 'spot' (default) or 'perp'; a perp agent has no vault and no mandate, its paper account is `deriv_account_id` (perp-engine.ts) */
  kind?: string; deriv_account_id?: string | null; perp?: unknown;
  /** V11 (agent-runtime/model.ts): family, template, engine ('bar' | 'stream' | 'supervisor'), the running configuration version and the persistent runtime state */
  family?: string | null; template?: string | null; engine?: string; config_version?: number; runtime?: Record<string, unknown> | null;
}
const Risk = z.strictObject({
  /** share of the vault that may be invested in non-USDC assets, percent */
  maxExposurePct: z.number().min(1).max(100).default(50),
  /** the engine stops the agent when equity falls this far below the allocated capital, percent (can be overshot by a gap) */
  maxLossPct: z.number().min(1).max(100).default(5),
  maxOrderUsd: z.number().min(1).max(100_000).default(25),
  maxDailyUsd: z.number().min(1).max(1_000_000).default(100),
  maxOrdersPerDay: z.number().int().min(1).max(200).default(12),
  mandateDays: z.number().int().min(1).max(90).default(30),
  slippageBps: z.number().int().min(5).max(300).default(50),
});
export type Risk = z.infer<typeof Risk>;
const Create = z.strictObject({ name: z.string().min(2).max(40), mission: z.string().max(400).default(''), network: z.string().min(2).max(24).default('base'),
  /** market symbols (BTC, ETH, LINK…), 1 to 12 */
  universe: z.array(z.string().regex(/^[A-Z0-9]{2,10}$/)).min(1).max(MAX_AGENT_SYMBOLS),
  /** optional: the registry asset to hold for a symbol ('native' or a token address); default = the stated rule of tradableSymbols */
  assets: z.record(z.string(), z.string().max(80)).default({}), cash: z.enum(['USDC', 'USDT']).optional(), interval: z.enum(['1h', '1d']).default('1h'),
  capitalUsdc: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/), risk: Risk.default(Risk.parse({})) });

/** The cash leg symbol of an agent. */
export const cashOf = (a: Pick<AgentRow, 'cash'>): string => a.cash ?? 'USDC';
/** The market symbols an agent trades (an agent created before V5 may list its cash leg in the universe). */
export const agentSymbols = (a: Pick<AgentRow, 'universe'>): string[] => a.universe.filter((s) => !CASH_SYMBOLS.includes(s));
export type AgentAssetRef = Pick<AgentRow, 'network' | 'universe'> & Partial<Pick<AgentRow, 'cash' | 'assets'>>;
/** Assets an agent holds on its network: the cash leg first, then ONE registry asset per market symbol (the representation
 *  recorded at creation; the default rule for agents created before V5). `symbol` is the market symbol (the cash symbol for the cash leg). */
export function agentAssets(a: AgentAssetRef, n: NetworkDef = getNetwork(a.network)): AgentAsset[] {
  try { const r = resolveAgentAssets(n, agentSymbols(a), { cash: a.cash ?? null, assets: a.assets ?? null }); return [r.cash, ...r.assets]; }
  catch (e) { throw new UserError('unsupported_asset', (e as Error).message, 422); }
}
const load = async (id: string): Promise<AgentRow> => {
  if (!z.uuid().safeParse(id).success) throw new UserError('not_found', 'agent not found', 404);
  const [a] = await sql<AgentRow[]>`select * from agents where id = ${id}`;
  if (!a) throw new UserError('not_found', 'agent not found', 404);
  return a;
};
export interface VaultBalance extends AgentAsset { amount: bigint; role: 'cash' | 'asset' | 'gas' }
export async function vaultBalances(a: AgentRow): Promise<VaultBalance[]> {
  const n = getNetwork(a.network), b = await adapterFor(a.network).balances(a.vault_address);
  const list: VaultBalance[] = agentAssets(a, n).map((x) => ({ ...x, amount: b[x.id] ?? 0n, role: x.kind === 'cash' ? 'cash' : 'asset' }));
  // the native coin pays the fees: shown even when the agent does not trade it (never part of the strategy's equity then)
  if (!list.some((x) => x.id === 'native')) list.push({ symbol: n.native.symbol, id: 'native', decimals: n.native.decimals, assetSymbol: n.native.symbol, name: n.native.name, kind: 'native', issuer: null, amount: b.native ?? 0n, role: 'gas' });
  return list;
}
const view = (a: AgentRow) => ({ id: a.id, name: a.name, mission: a.mission, state: a.state, mode: a.mode, network: a.network, networkName: getNetwork(a.network).name, universe: a.universe, cash: cashOf(a), interval: a.interval, risk: a.risk,
  holdings: (() => { try { return agentAssets(a).map((x) => ({ symbol: x.symbol, asset: x.id, assetSymbol: x.assetSymbol, name: x.name, kind: x.kind, issuer: x.issuer })); } catch { return null; } })(),
  vaultAddress: a.vault_address, vaultIndex: a.vault_index, capitalUsdc: formatUnits(BigInt(a.capital_usdc), 6), strategyVersionId: a.strategy_version_id, mandateId: a.mandate_id,
  mandate: a.mandate ? { expiresAt: a.mandate.expiresAt, label: a.mandate.label, strategySha256: a.mandate.strategySha256, maxOrdersPerDay: a.mandate.maxOrdersPerDay } : null,
  // V11: family, running configuration version, and where a paused agent came from (D9: 'LIVE' → resuming needs a new mandate)
  family: a.family ?? 'custom', template: a.template ?? null, engine: a.engine ?? 'bar', configVersion: a.config_version ?? 1, pausedFrom: (a.runtime as { pausedFrom?: string } | null)?.pausedFrom ?? null,
  lastBar: a.last_bar, stopReason: a.stop_reason, createdAt: a.created_at, updatedAt: a.updated_at });
/** V11: the list/detail view of an agent run by the stream engine or the supervisor (no vault, no network) */
export const runtimeView = (a: AgentRow) => ({ id: a.id, kind: a.kind ?? 'stream', name: a.name, mission: a.mission, state: a.state, mode: a.mode, family: a.family ?? 'custom', template: a.template ?? null, engine: a.engine ?? 'stream',
  network: a.network, networkName: a.kind === 'supervisor' ? 'All agents' : ((a.runtime as { venues?: string[] } | null)?.venues ?? []).join(' + '), universe: a.universe, cash: 'USDC', interval: a.interval, risk: a.risk,
  capitalUsdc: formatUnits(BigInt(a.capital_usdc), 6), strategyVersionId: null, mandateId: null, mandate: null, vaultAddress: '', holdings: null, configVersion: a.config_version ?? 1, simulation: true,
  lastBar: a.last_bar, stopReason: a.stop_reason, createdAt: a.created_at, updatedAt: a.updated_at });

/** Build the mandate from the agent's risk settings: USD caps become per-asset base-unit caps at current prices. */
export function mandateFor(a: AgentRow, keyId: string, strategySha256: string, prices: Record<string, number>, now: number): Mandate {
  const assets = agentAssets(a);
  // the mandate schema holds at most 12 assets, cash leg included (a signer limit that V5 does not raise)
  if (assets.length > 12) throw new UserError('too_many_assets', `a mandate covers at most 12 assets: the cash leg and 11 symbols; this agent has ${assets.length - 1} symbols (paper trading only)`, 422);
  const blind = assets.filter((x) => x.kind !== 'cash' && !hasSignerPrice(x.symbol)).map((x) => x.symbol);
  if (blind.length) throw new UserError('no_signer_price', `the signer prices an asset only from Coinbase and Kraken together; ${blind.join(', ')} ${blind.length > 1 ? 'are' : 'is'} not listed on both, so every order would be refused (paper trading only)`, 422);
  const cap = (usd: number, x: AgentAsset) => { const p = x.kind === 'cash' ? 1 : prices[x.symbol]; if (!p || !(p > 0)) throw new UserError('no_price', `no market price for ${x.symbol}; cannot size the mandate`, 503);
    return parseUnits((usd / p).toFixed(Math.min(x.decimals, 8)), x.decimals).toString(); };
  const m: Mandate = { v: 1, mandateId: randomUUID(), keyId, vaultIndex: a.vault_index, vault: a.vault_address, network: a.network, provider: 'kyberswap', assets: assets.map((x) => x.id),
    maxOrder: Object.fromEntries(assets.map((x) => [x.id, cap(a.risk.maxOrderUsd, x)])), maxDaily: Object.fromEntries(assets.map((x) => [x.id, cap(a.risk.maxDailyUsd, x)])),
    maxOrdersPerDay: a.risk.maxOrdersPerDay, maxSlippageBps: Math.min(500, Math.max(150, a.risk.slippageBps + 80)), createdAt: now, expiresAt: now + a.risk.mandateDays * 86400, strategySha256, label: a.name.slice(0, 60) };
  validateMandate(MandateSchema.parse(m), now);
  return m;
}

export interface AgentDeps { prices: () => Promise<Record<string, { usd: number }> | null> }
/** USD price of market symbols: the wallet's price feed, else the last stored candle close (symbols the feed does not carry). */
export async function symbolPrices(symbols: string[], feed: Record<string, { usd: number }> | null): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of new Set(symbols)) {
    const p = feed?.[s]?.usd;
    if (p !== undefined && p > 0) { out[s] = p; continue; }
    try { const bar = (await getSeries(s, '1h', { limit: 1 })).bars.at(-1); if (bar && Date.now() - bar.ts < 6 * 3_600_000) out[s] = bar.close; } catch { /* no price: the caller decides */ }
  }
  return out;
}
/** An agent may go LIVE only with the gas reserve of its network in the vault. Returns the reserve and the balance. */
export async function requireGasReserve(a: AgentRow, feeCeiling: string | undefined, reserve: (n: NetworkDef, feeCeiling: string | undefined) => Promise<GasReserve> = gasReserve): Promise<{ reserve: bigint; held: bigint }> {
  const n = getNetwork(a.network);
  let r: GasReserve;
  try { r = await reserve(n, feeCeiling); } catch (e) { throw new UserError('no_gas_estimate', `the gas reserve on ${n.name} cannot be computed (${(e as Error).message.slice(0, 100)}); live trading is not started`, 503); }
  const held = (await adapterFor(a.network).balances(a.vault_address)).native ?? 0n;
  if (held < r.reserve) throw new UserError('insufficient_gas', `the vault holds ${formatUnits(held, n.native.decimals)} ${n.native.symbol}; live trading on ${n.name} needs a gas reserve of ${formatUnits(r.reserve, n.native.decimals)} ${n.native.symbol} (${RESERVE_ORDERS} orders at recent gas prices, at least ${FLOOR_ORDERS} at the signer's fee ceiling). Send it to the vault first.`, 409);
  return { reserve: r.reserve, held };
}

/** Owner (or risk-supervisor) change of state of a SPOT agent. Never needs a passkey: none of these adds authority.
 *  V11 — D9: a LIVE agent can be PAUSED; the mandate is revoked at the signer at once (nothing stays signable while it is paused)
 *  and `runtime.pausedFrom = 'LIVE'` records where it came from, so that the page offers "resume": a NEW mandate, approved by
 *  the owner's passkey (the signer has no way to suspend a spot mandate, and inventing one would weaken it).
 *  D11: "RESEARCH" is a MODE, not a state: the state goes back to the pre-trading one. */
export async function setSpotMode(a: AgentRow, mode: 'PAPER' | 'PAUSED' | 'STOPPED' | 'RESEARCH', actor: string): Promise<AgentRow> {
  if (mode === 'PAPER' && !a.strategy_version_id) throw new UserError('no_strategy', 'approve a strategy version first', 409);
  if (a.state === 'LIVE' && mode === 'PAPER') throw new UserError('bad_state', 'revoke the mandate before returning to paper trading', 409);
  const state = mode === 'PAPER' ? 'PAPER_TRADING' : mode === 'RESEARCH' ? (a.strategy_version_id ? 'AWAITING_APPROVAL' : 'CREATED') : mode;
  const wasLive = a.state === 'LIVE';
  const pausedFrom = mode === 'PAUSED' ? (wasLive ? 'LIVE' : a.state === 'PAUSED' ? (a.runtime as { pausedFrom?: string } | null)?.pausedFrom ?? 'PAPER' : 'PAPER') : null;
  const [r] = await sql<AgentRow[]>`update agents set state = ${state}, mode = ${mode === 'PAPER' ? 'PAPER' : mode === 'RESEARCH' ? 'RESEARCH' : a.mode}, stop_reason = ${mode === 'STOPPED' ? `stopped by the ${actor === 'owner' ? 'owner' : actor}` : null},
    runtime = (coalesce(runtime, '{}'::jsonb) - 'pausedFrom') || ${sql.json((pausedFrom ? { pausedFrom } : {}) as never)}, updated_at = now() where id = ${a.id} returning *`;
  await audit('agent.mode', actor, { id: a.id, state });
  await sql`insert into research_log (agent_id, kind, title, body, mode, code) values (${a.id}, 'state', ${`${state === 'PAPER_TRADING' ? 'Paper trading started' : state === 'PAUSED' ? 'Paused' : state === 'STOPPED' ? 'Stopped' : 'Back to research'} by the ${actor === 'owner' ? 'owner' : actor}`},
    ${wasLive ? 'The mandate is revoked at the signer: nothing can be signed for this agent until the owner approves a new one.' : ''}, ${wasLive ? 'LIVE' : mode === 'PAPER' ? 'PAPER' : null}, ${`state_${state.toLowerCase()}`})`.catch(() => {});
  // V11 (D2): leaving LIVE — stopped, paused or back to research — ends the mandate AT THE SIGNER too. The state change above is
  // not undone when the signer cannot be reached: stopping always works, and the engine revokes at its next pass.
  if (wasLive && a.mandate_id) await revokeAgentMandate(a, `the ${actor} set the agent to ${state}`);
  return r!;
}

export function agentRoutes(app: FastifyInstance, deps: AgentDeps): void {
  // what an agent can trade, network by network: derived from the token registry and the static table of listings
  app.get('/api/v1/agents/networks', async () => {
    const feed = await deps.prices().catch(() => null), st = await signer.status().catch(() => null);
    const quality = await listQuality().catch(() => []);
    const networks = await Promise.all(MANDATE_NETWORKS.map(async (id) => {
      const n = getNetwork(id), cash = cashLegs(n), symbols = tradableSymbols(n);
      let gas: { reserve: string; perOrder: string; perOrderUsd: number | null; gasPriceGwei: number } | null = null;
      try { const r = await gasReserve(n, st?.policy.maxFee[id]); const usd = (await symbolPrices([n.native.symbol], feed))[n.native.symbol];
        gas = { reserve: formatUnits(r.reserve, n.native.decimals), perOrder: formatUnits(r.perOrder, n.native.decimals), perOrderUsd: usd === undefined ? null : Number(formatUnits(r.perOrder, n.native.decimals)) * usd, gasPriceGwei: Number(r.gasPrice) / 1e9 }; } catch { /* shown as unknown */ }
      return { id, name: n.name, native: n.native.symbol, enabled: cash.length > 0 && symbols.length > 0, cash: cash.map((c) => ({ symbol: c.symbol, asset: c.id, name: c.name })), defaultCash: cash.some((c) => c.symbol === 'USDC') ? 'USDC' : null,
        gas, feeWarning: id === 'ethereum' || (gas?.perOrderUsd ?? 0) > 1,
        symbols: symbols.map((t) => ({ symbol: t.symbol, sources: t.sources, live: t.live, defaultAsset: t.defaultId,
          data: Object.fromEntries(['1h', '1d'].map((iv) => { const q = quality.find((x) => x.symbol === t.symbol && x.interval === iv); return [iv, q ? { status: q.status, fresh: q.fresh, lastTs: q.last_ts } : null]; })),
          representations: t.representations.map((r) => ({ asset: r.id, assetSymbol: r.assetSymbol, name: r.name, kind: r.kind, issuer: r.issuer })) })) };
    }));
    return { networks, maxSymbols: MAX_AGENT_SYMBOLS, maxLiveSymbols: 11, feeWarnShare: FEE_WARN_SHARE };
  });

  app.get('/api/v1/agents', async () => ({ agents: (await sql<AgentRow[]>`select * from agents order by created_at desc`).map((a) => (isPerp(a) ? perpView(a) : a.kind && a.kind !== 'spot' ? runtimeView(a) : view(a))) })); // v6: perp agents have their own view; V11: stream and supervisor agents too

  app.post('/api/v1/agents', async (req) => {
    if ((req.body as { kind?: unknown } | null)?.kind === 'perp') return createPerpAgent(req.body); // v6: a perp agent (paper account, no vault, no signer call)
    const b = Create.parse(req.body);
    if (!MANDATE_NETWORKS.includes(b.network)) throw new UserError('unsupported_network', `agents trade on ${MANDATE_NETWORKS.map((x) => getNetwork(x).name).join(', ')}`, 422);
    const n = getNetwork(b.network);
    // every symbol must have market data and exactly one registry asset on this network; the choice is recorded with the agent
    let resolved: AgentAsset[];
    try { const r = resolveAgentAssets(n, b.universe, { cash: b.cash ?? null, assets: b.assets }); resolved = [r.cash, ...r.assets]; } catch (e) { throw new UserError('unsupported_asset', (e as Error).message, 422); }
    const cash = resolved[0]!, chosen = Object.fromEntries(resolved.slice(1).map((x) => [x.symbol, x.id]));
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const id = randomUUID();
    const [row] = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7707002)`;
      // one vault index per agent, whatever its network: the same index would be the same address on every EVM network
      const rows = await tx<{ next: number }[]>`select coalesce(max(vault_index), 0) + 1 as next from agents`;
      const next = rows[0]!.next;
      const { address } = await signer.vaultAddress(next); // derived by the signer; the API never chooses it
      return tx<AgentRow[]>`insert into agents (id, name, mission, network, universe, cash, assets, interval, risk, vault_index, vault_address, capital_usdc)
        values (${id}, ${b.name}, ${b.mission}, ${n.id}, ${tx.json(b.universe)}, ${cash.symbol}, ${tx.json(chosen)}, ${b.interval}, ${tx.json(b.risk as never)}, ${next}, ${address}, ${parseUnits(b.capitalUsdc, 6).toString()}) returning *`;
    });
    await audit('agent.created', 'owner', { id, name: b.name, network: n.id, vault: row!.vault_address, vaultIndex: row!.vault_index, universe: b.universe, cash: cash.symbol, assets: chosen });
    await (await import('../agent-runtime/store.ts')).bumpConfig(id, 'owner', 'created');   // V11: configuration version 1
    // warnings never block: network fees against the order size, symbols that can only be paper traded
    const warnings: { code: string; message: string }[] = [];
    try { const r = await gasReserve(n, st.policy.maxFee[n.id]); const usd = (await symbolPrices([n.native.symbol], await deps.prices().catch(() => null)))[n.native.symbol];
      if (usd !== undefined) { const share = feeShare(r.perOrder, n.native.decimals, usd, b.risk.maxOrderUsd);
        if (share > FEE_WARN_SHARE) warnings.push({ code: 'fees', message: `on ${n.name} one order costs about ${(Number(formatUnits(r.perOrder, n.native.decimals)) * usd).toFixed(2)} USD in network fees: ${(100 * share).toFixed(1)} % of this agent's largest order (${b.risk.maxOrderUsd} USD). Small orders are eaten by fees.` }); } } catch { /* no estimate: no warning */ }
    const paperOnly = resolved.slice(1).filter((x) => !hasSignerPrice(x.symbol)).map((x) => x.symbol);
    if (paperOnly.length) warnings.push({ code: 'paper_only', message: `${paperOnly.join(', ')}: not listed on both Coinbase and Kraken, so the signer cannot price it; this agent can be paper traded but not go live` });
    if (resolved.length > 12) warnings.push({ code: 'paper_only', message: 'a mandate covers at most 12 assets (the cash leg and 11 symbols): with 12 symbols this agent can be paper traded but not go live' });
    return { ...view(row!), warnings };
  });

  app.get('/api/v1/agents/:id', async (req) => {
    const a = await load((req.params as { id: string }).id);
    if (isPerp(a)) return perpDetail(a); // v6
    if (a.kind && a.kind !== 'spot') return runtimeView(a); // V11: the agent panel reads /agents/:id/overview for these
    const balances = await vaultBalances(a).catch(() => null);
    const px = await symbolPrices((balances ?? []).filter((x) => x.kind !== 'cash').map((x) => x.symbol), await deps.prices().catch(() => null));
    const usd = (x: VaultBalance) => { const p = x.kind === 'cash' ? 1 : px[x.symbol]; return p === undefined ? null : Number(formatUnits(x.amount, x.decimals)) * p; };
    const versions = await sql`select id, name, version, code_sha256, status, notes, created_at, approved_at, report->'metrics' as metrics, report->'robustness' as robustness, report->'benchmarks' as benchmarks, report->'config' as config from strategy_versions where agent_id = ${a.id} order by created_at desc`;
    // V11 (D5): orders, equity and journal of the mode the agent is in NOW (LIVE, else PAPER) — never both in one list or one curve.
    // The other mode is read through /agents/:id/orders|performance|journal?mode=…
    const cur = a.mode === 'LIVE' ? 'LIVE' : 'PAPER';
    const orders = await sql`select id, ts, mode, from_symbol, to_symbol, amount_in, expected_out, min_out, received, state, reason, txid from agent_orders where agent_id = ${a.id} and mode = ${cur} order by ts desc limit 60`;
    const equity = await sql`select ts, mode, equity_usd from agent_equity where agent_id = ${a.id} and mode = ${cur} order by ts desc limit 500`;
    const log = await sql`select ts, kind, title, body, mode, severity, code from research_log where agent_id = ${a.id} and (mode = ${cur} or mode = 'RESEARCH') order by id desc limit 40`;
    const st = await signer.status().catch(() => null);
    const sm = st?.mandates?.find((m) => m.mandate.mandateId === a.mandate_id) ?? null;
    return { ...view(a),
      vault: balances ? balances.map((x) => ({ symbol: x.symbol, assetSymbol: x.assetSymbol, name: x.name, kind: x.kind, issuer: x.issuer, role: x.role, asset: x.id, amount: x.amount.toString(), display: formatUnits(x.amount, x.decimals), usd: usd(x) })) : null,
      mandateStatus: sm ? { active: !sm.revoked && !sm.expired, revoked: sm.revoked, expired: sm.expired, expiresAt: sm.mandate.expiresAt, today: sm.today, maxOrder: sm.mandate.maxOrder, maxDaily: sm.mandate.maxDaily, maxOrdersPerDay: sm.mandate.maxOrdersPerDay } : null,
      // v8 hardening: the SIMULATED positions (paper book), read-only and separate from the real vault above; null when the agent never ran on paper
      paper: await paperBookView(a.id, cashOf(a), agentSymbols(a), async (s) => symbolPrices(s, await deps.prices().catch(() => null))).catch(() => null),
      versions, orders, equity: equity.reverse(), log };
  });

  // paper trading needs no mandate: it signs nothing
  app.post('/api/v1/agents/:id/mode', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const b = z.strictObject({ mode: z.enum(['PAPER', 'PAUSED', 'STOPPED', 'RESEARCH']) }).parse(req.body);
    if (isPerp(a)) return perpMode(a, b.mode); // v6
    if (a.kind && a.kind !== 'spot') throw new UserError('wrong_kind', 'this agent is run by the stream engine or the supervisor: use the agent panel (start, pause, stop)', 409); // V11
    return view(await setSpotMode(a, b.mode, 'owner'));
  });

  // strategy versions: registered by the research side (path + hash), approved by the owner
  app.post('/api/v1/agents/:id/strategies/:sid/approve', async (req) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const a = await load(id);
    const [v] = await sql`select * from strategy_versions where id = ${z.uuid().parse(sid)} and agent_id = ${a.id}`;
    if (!v) throw new UserError('not_found', 'strategy version not found', 404);
    if (!v.report) throw new UserError('no_report', 'this version has no backtest report: it cannot be approved', 409);
    // V11 (D4): a report whose own look-ahead check did not pass is not evidence of anything — the perp path already refuses it (perp-strategies.ts)
    if (!isPerp(a) && (v.meta as { kind?: string } | null)?.kind !== 'perp' && (v.report as { checks?: Record<string, unknown> } | null)?.checks?.lookahead !== 'pass')
      throw new UserError('bad_report', 'the report\'s own look-ahead check did not pass (or the report carries none): this version cannot be approved. Run the backtest again; a strategy that reads future bars fails it.', 409);
    // v6: kinds never cross — a perp agent approves only a contract-2 version with a valid version-2 report, a spot agent never one
    if (isPerp(a)) assertPerpApprovable(a, v as never); else if ((v.meta as { kind?: string } | null)?.kind === 'perp') throw new UserError('wrong_kind', 'a perpetual-futures strategy cannot run on a spot agent', 409);
    if (a.state === 'LIVE') throw new UserError('bad_state', 'the code of a live agent cannot change: revoke the mandate first, then approve the new version and a new mandate', 409);
    await sql`update strategy_versions set status = 'retired' where agent_id = ${a.id} and status = 'approved'`;
    await sql`update strategy_versions set status = 'approved', approved_at = now(), approved_by = 'owner' where id = ${v.id}`;   // V11: only an owner approval can be pinned by a live mandate
    const [r] = await sql<AgentRow[]>`update agents set strategy_version_id = ${v.id}, state = case when state in ('CREATED','RESEARCHING','BACKTESTING','AWAITING_APPROVAL') then 'AWAITING_APPROVAL' else state end, updated_at = now() where id = ${a.id} returning *`;
    await audit('strategy.approved', 'owner', { agent: a.id, version: v.id, sha256: v.code_sha256 });
    await (await import('../agent-runtime/store.ts')).bumpConfig(a.id, 'owner', `strategy version ${v.name}/${v.version} (${String(v.code_sha256).slice(0, 12)}…) approved`);   // V11: a new strategy is a new configuration version
    if (isPerp(r!)) return perpView(r!); // v6
    return view(r!);
  });

  // mandate: prepared from the agent's limits, approved with a passkey whose challenge is the mandate hash
  app.post('/api/v1/agents/:id/mandate/prepare', async (req) => {
    const a = await load((req.params as { id: string }).id); spotOnly(a); // v6: vault and mandate routes are for spot agents
    return (await import('./mandate-write.ts')).prepareSpotMandate(a, deps);  // V11: the mandate-writing module (never imported by the engines)
  });
  app.post('/api/v1/agents/:id/mandate/approve', async (req) => {
    const a = await load((req.params as { id: string }).id); spotOnly(a); // v6: vault and mandate routes are for spot agents
    const b = z.object({ assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    return view(await (await import('./mandate-write.ts')).approveSpotMandate(a, b.assertion));
  });
  // stopping never needs a passkey
  app.post('/api/v1/agents/:id/revoke', async (req) => {
    const a = await load((req.params as { id: string }).id); spotOnly(a); // v6: vault and mandate routes are for spot agents
    if (a.mandate_id) await signer.mandateRevoke(a.mandate_id);
    const [row] = await sql<AgentRow[]>`update agents set state = 'STOPPED', stop_reason = 'mandate revoked by the owner', updated_at = now() where id = ${a.id} returning *`;
    await audit('mandate.revoked', 'owner', { agent: a.id, mandateId: a.mandate_id });
    return view(row!);
  });

  // what the vault's address holds on every EVM network (the same address exists on all of them)
  app.get('/api/v1/agents/:id/elsewhere', async (req) => {
    const a = await load((req.params as { id: string }).id); spotOnly(a); // v6: vault and mandate routes are for spot agents
    const nets = Object.values(NETWORKS).filter((n) => n.family === 'evm' && n.id !== a.network);
    const found = (await Promise.all(nets.map(async (n) => { try { const b = await adapterFor(n.id).balances(a.vault_address);
      const held = [n.native, ...n.tokens].filter((x) => (b[x.id] ?? 0n) > 0n);
      if (!held.length) return [];
      // display only: what one token withdrawal would cost right now (the arithmetic of the withdraw route below), so the page can say what is missing
      let need: bigint | null = null;
      try { const block = await rpcAny<{ baseFeePerGas?: `0x${string}` }>(n.rpc, 'eth_getBlockByNumber', ['latest', false]); let tip = 1_000_000n; try { tip = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_maxPriorityFeePerGas', [])); } catch { /* floor */ }
        need = 90_000n * (hexToBigInt(block.baseFeePerGas ?? '0x0') * 2n + tip); } catch { /* unknown: the page falls back to hasGas */ }
      return held.map((x) => ({ network: n.id, networkName: n.name, asset: x.id, symbol: x.symbol, display: formatUnits(b[x.id]!, x.decimals), gas: n.native.symbol, hasGas: (b.native ?? 0n) > 0n,
        gasHeld: formatUnits(b.native ?? 0n, n.native.decimals), gasNeed: need === null ? null : formatUnits(need, n.native.decimals), gasEnough: need === null ? null : (b.native ?? 0n) >= need })); } catch { return []; } }))).flat();
    return { address: a.vault_address, holdings: found };
  });

  // bring funds back: a vault can only pay the owner's own address (enforced by the signer)
  // v8: a tracked operation (withdrawals.ts) — the answer carries its real state; `ok` is true only once it was broadcast
  app.post('/api/v1/agents/:id/withdraw', async (req) => {
    const a = await load((req.params as { id: string }).id); spotOnly(a); // v6: vault and mandate routes are for spot agents
    const b = z.strictObject({ asset: z.string().max(80), network: z.string().max(24).optional(), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional() }).parse(req.body);
    return requestWithdrawal(a, b);
  });
  app.get('/api/v1/agents/:id/withdrawals', async (req) => {
    const a = await load((req.params as { id: string }).id);
    return { withdrawals: await listWithdrawals(a.id), broadcast: config.broadcast };
  });
  app.get('/api/v1/agents/:id/withdrawals/:wid', async (req) => {
    const p = req.params as { id: string; wid: string }, a = await load(p.id);
    const w = await getWithdrawal(a.id, z.uuid().parse(p.wid));
    if (!w) throw new UserError('not_found', 'withdrawal not found', 404);
    return w;
  });
}
