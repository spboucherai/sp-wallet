// Trading agents (V3): lifecycle, vaults, mandates. The engine that trades is in engine.ts; nothing here signs anything
// except through the signer's mandate endpoints.
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

export interface AgentRow {
  id: string; name: string; mission: string; state: string; mode: string; network: string; universe: string[]; interval: string;
  /** cash leg symbol (USDC unless the owner chose USDT) and the registry asset chosen for each market symbol; null/empty on agents created before V5 */
  cash: string | null; assets: Record<string, string> | null;
  risk: Risk; vault_index: number; vault_address: string; capital_usdc: string; strategy_version_id: string | null; mandate_id: string | null; mandate: Mandate | null;
  last_bar: Date | null; stop_reason: string | null; created_at: Date; updated_at: Date;
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

  app.get('/api/v1/agents', async () => ({ agents: (await sql<AgentRow[]>`select * from agents order by created_at desc`).map(view) }));

  app.post('/api/v1/agents', async (req) => {
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
    const balances = await vaultBalances(a).catch(() => null);
    const px = await symbolPrices((balances ?? []).filter((x) => x.kind !== 'cash').map((x) => x.symbol), await deps.prices().catch(() => null));
    const usd = (x: VaultBalance) => { const p = x.kind === 'cash' ? 1 : px[x.symbol]; return p === undefined ? null : Number(formatUnits(x.amount, x.decimals)) * p; };
    const versions = await sql`select id, name, version, code_sha256, status, notes, created_at, approved_at, report->'metrics' as metrics, report->'robustness' as robustness, report->'benchmarks' as benchmarks, report->'config' as config from strategy_versions where agent_id = ${a.id} order by created_at desc`;
    const orders = await sql`select id, ts, mode, from_symbol, to_symbol, amount_in, expected_out, min_out, received, state, reason, txid from agent_orders where agent_id = ${a.id} order by ts desc limit 60`;
    const equity = await sql`select ts, mode, equity_usd from agent_equity where agent_id = ${a.id} order by ts desc limit 500`;
    const log = await sql`select ts, kind, title, body from research_log where agent_id = ${a.id} order by ts desc limit 40`;
    const st = await signer.status().catch(() => null);
    const sm = st?.mandates?.find((m) => m.mandate.mandateId === a.mandate_id) ?? null;
    return { ...view(a),
      vault: balances ? balances.map((x) => ({ symbol: x.symbol, assetSymbol: x.assetSymbol, name: x.name, kind: x.kind, issuer: x.issuer, role: x.role, asset: x.id, amount: x.amount.toString(), display: formatUnits(x.amount, x.decimals), usd: usd(x) })) : null,
      mandateStatus: sm ? { active: !sm.revoked && !sm.expired, revoked: sm.revoked, expired: sm.expired, expiresAt: sm.mandate.expiresAt, today: sm.today, maxOrder: sm.mandate.maxOrder, maxDaily: sm.mandate.maxDaily, maxOrdersPerDay: sm.mandate.maxOrdersPerDay } : null,
      versions, orders, equity: equity.reverse(), log };
  });

  // paper trading needs no mandate: it signs nothing
  app.post('/api/v1/agents/:id/mode', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const b = z.strictObject({ mode: z.enum(['PAPER', 'PAUSED', 'STOPPED', 'RESEARCH']) }).parse(req.body);
    if (b.mode === 'PAPER' && !a.strategy_version_id) throw new UserError('no_strategy', 'approve a strategy version first', 409);
    if (a.state === 'LIVE' && b.mode === 'PAPER') throw new UserError('bad_state', 'revoke the mandate before returning to paper trading', 409);
    const state = b.mode === 'PAPER' ? 'PAPER_TRADING' : b.mode;
    const [r] = await sql<AgentRow[]>`update agents set state = ${state}, mode = ${b.mode === 'PAPER' ? 'PAPER' : a.mode}, stop_reason = ${b.mode === 'STOPPED' ? 'stopped by the owner' : null}, updated_at = now() where id = ${a.id} returning *`;
    await audit('agent.mode', 'owner', { id: a.id, state });
    return view(r!);
  });

  // strategy versions: registered by the research side (path + hash), approved by the owner
  app.post('/api/v1/agents/:id/strategies/:sid/approve', async (req) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const a = await load(id);
    const [v] = await sql`select * from strategy_versions where id = ${z.uuid().parse(sid)} and agent_id = ${a.id}`;
    if (!v) throw new UserError('not_found', 'strategy version not found', 404);
    if (!v.report) throw new UserError('no_report', 'this version has no backtest report: it cannot be approved', 409);
    if (a.state === 'LIVE') throw new UserError('bad_state', 'the code of a live agent cannot change: revoke the mandate first, then approve the new version and a new mandate', 409);
    await sql`update strategy_versions set status = 'retired' where agent_id = ${a.id} and status = 'approved'`;
    await sql`update strategy_versions set status = 'approved', approved_at = now() where id = ${v.id}`;
    const [r] = await sql<AgentRow[]>`update agents set strategy_version_id = ${v.id}, state = case when state in ('CREATED','RESEARCHING','BACKTESTING','AWAITING_APPROVAL') then 'AWAITING_APPROVAL' else state end, updated_at = now() where id = ${a.id} returning *`;
    await audit('strategy.approved', 'owner', { agent: a.id, version: v.id, sha256: v.code_sha256 });
    return view(r!);
  });

  // mandate: prepared from the agent's limits, approved with a passkey whose challenge is the mandate hash
  app.post('/api/v1/agents/:id/mandate/prepare', async (req) => {
    const a = await load((req.params as { id: string }).id);
    if (!a.strategy_version_id) throw new UserError('no_strategy', 'approve a strategy version first', 409);
    if (a.state === 'LIVE') throw new UserError('bad_state', 'a mandate is already active; revoke it to change limits', 409);
    const [v] = await sql`select code_sha256 from strategy_versions where id = ${a.strategy_version_id}`;
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const px = await symbolPrices(agentSymbols(a), await deps.prices().catch(() => null));
    const mandate = mandateFor(a, st.keyId, v!.code_sha256, px, Math.floor(Date.now() / 1000));
    const gas = await requireGasReserve(a, st.policy.maxFee[a.network]); // no reserve, no live trading
    const hash = mandateHash(mandate);
    await sql`update agents set mandate = ${sql.json(mandate as never)}, updated_at = now() where id = ${a.id}`;
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 120_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    const n = getNetwork(a.network);
    const human = agentAssets(a, n).map((x) => ({ symbol: x.assetSymbol === x.symbol ? x.symbol : `${x.assetSymbol} (${x.symbol})`, tracks: x.symbol, assetSymbol: x.assetSymbol, kind: x.kind, issuer: x.issuer, maxOrder: formatUnits(BigInt(mandate.maxOrder[x.id]!), x.decimals), maxDaily: formatUnits(BigInt(mandate.maxDaily[x.id]!), x.decimals) }));
    return { mandate, hash: toHex(hash), limits: human, options, network: n.id, networkName: n.name, gasReserve: { required: formatUnits(gas.reserve, n.native.decimals), held: formatUnits(gas.held, n.native.decimals), symbol: n.native.symbol } };
  });
  app.post('/api/v1/agents/:id/mandate/approve', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const b = z.object({ assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    if (!a.mandate) throw new UserError('bad_state', 'prepare the mandate first', 409);
    await requireGasReserve(a, (await signer.status(true)).policy.maxFee[a.network]);
    const r = await signer.mandateApprove(a.mandate, b.assertion); // only the signer judges the passkey and stores the limits
    const [row] = await sql<AgentRow[]>`update agents set mandate_id = ${r.mandateId}, state = 'LIVE', mode = 'LIVE', stop_reason = null, updated_at = now() where id = ${a.id} returning *`;
    await audit('mandate.approved', 'owner', { agent: a.id, mandateId: r.mandateId, hash: r.hash });
    return view(row!);
  });
  // stopping never needs a passkey
  app.post('/api/v1/agents/:id/revoke', async (req) => {
    const a = await load((req.params as { id: string }).id);
    if (a.mandate_id) await signer.mandateRevoke(a.mandate_id);
    const [row] = await sql<AgentRow[]>`update agents set state = 'STOPPED', stop_reason = 'mandate revoked by the owner', updated_at = now() where id = ${a.id} returning *`;
    await audit('mandate.revoked', 'owner', { agent: a.id, mandateId: a.mandate_id });
    return view(row!);
  });

  // what the vault's address holds on every EVM network (the same address exists on all of them)
  app.get('/api/v1/agents/:id/elsewhere', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const nets = Object.values(NETWORKS).filter((n) => n.family === 'evm' && n.id !== a.network);
    const found = (await Promise.all(nets.map(async (n) => { try { const b = await adapterFor(n.id).balances(a.vault_address);
      return [n.native, ...n.tokens].filter((x) => (b[x.id] ?? 0n) > 0n).map((x) => ({ network: n.id, networkName: n.name, asset: x.id, symbol: x.symbol, display: formatUnits(b[x.id]!, x.decimals), gas: n.native.symbol, hasGas: (b.native ?? 0n) > 0n })); } catch { return []; } }))).flat();
    return { address: a.vault_address, holdings: found };
  });

  // bring funds back: a vault can only pay the owner's own address (enforced by the signer)
  app.post('/api/v1/agents/:id/withdraw', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const b = z.strictObject({ asset: z.string().max(80), network: z.string().max(24).optional() }).parse(req.body);
    // any EVM network: funds sent to the vault's address on another network than the agent's can always come back
    const n = getNetwork(b.network ?? a.network);
    if (n.family !== 'evm') throw new UserError('unsupported_network', 'agent wallets exist on EVM networks only', 422);
    if (a.state === 'LIVE' && n.id === a.network) throw new UserError('bad_state', 'revoke the mandate before withdrawing', 409);
    const asset = getAsset(n.id, b.asset), st = await signer.status(true);
    const owner = st.addresses[n.id]!;
    const bal = await adapterFor(n.id).balances(a.vault_address);
    const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [a.vault_address, 'pending']));
    const block = await rpcAny<{ baseFeePerGas?: `0x${string}` }>(n.rpc, 'eth_getBlockByNumber', ['latest', false]);
    const baseFee = hexToBigInt(block.baseFeePerGas ?? '0x0'); let tip = 1_000_000n; try { tip = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_maxPriorityFeePerGas', [])); } catch { /* floor */ }
    const maxFeePerGas = baseFee * 2n + tip, gas = asset.id === 'native' ? 21_000n : 90_000n, fee = gas * maxFeePerGas;
    const amount = asset.id === 'native' ? (bal.native ?? 0n) - fee : (bal[asset.id] ?? 0n);
    if (amount <= 0n) throw new UserError('insufficient_funds', `nothing to withdraw in ${asset.symbol}`);
    if (asset.id !== 'native' && (bal.native ?? 0n) < fee) throw new UserError('insufficient_gas', `the vault needs a little ${n.native.symbol} to pay the network fee`);
    const now = Math.floor(Date.now() / 1000);
    const intent = IntentSchema.parse({ v: 1, proposalId: randomUUID(), keyId: vaultKeyId(st.keyId, a.vault_index), network: n.id, chainRef: n.chainRef, asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, amount: amount.toString(),
      from: a.vault_address, to: owner, maxFee: fee.toString(), createdAt: now, expiresAt: now + 120, policyVersion: st.policy.version,
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() } });
    const signed = await signer.vaultReturn(a.vault_index, intent); // needs no mandate: the signer only ever pays the owner's own address
    if (config.broadcast) await adapterFor(n.id).broadcast(signed.raw);
    await audit('agent.withdraw', 'owner', { agent: a.id, network: n.id, symbol: asset.symbol, amount: amount.toString(), txid: signed.txid });
    return { ok: true, txid: signed.txid, symbol: asset.symbol, amount: formatUnits(amount, asset.decimals), explorer: n.explorerTx + signed.txid };
  });
}
