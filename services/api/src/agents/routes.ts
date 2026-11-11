// Trading agents (V3): lifecycle, vaults, mandates. The engine that trades is in engine.ts; nothing here signs anything
// except through the signer's mandate endpoints.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { hexToBigInt, hexToNumber } from 'viem';
import { z } from 'zod';
import { formatUnits, getAsset, getNetwork, IntentSchema, KYBER_ENABLED, mandateHash, MandateSchema, parseUnits, toB64u, toHex, validateMandate, vaultKeyId, type Mandate, type NetworkDef } from '@spw/core';
import { listCreds } from '../auth.ts';
import { adapterFor } from '../chains/index.ts';
import { rpcAny, rpcQuorum } from '../chains/rpc.ts';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { signer } from '../signer-client.ts';

export interface AgentRow {
  id: string; name: string; mission: string; state: string; mode: string; network: string; universe: string[]; interval: string;
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
const Create = z.strictObject({ name: z.string().min(2).max(40), mission: z.string().max(400).default(''), universe: z.array(z.string().min(2).max(8)).min(1).max(6), interval: z.enum(['1h', '1d']).default('1h'),
  capitalUsdc: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/), risk: Risk.default(Risk.parse({})) });

/** Assets an agent can trade on its network: the symbol's registry asset, plus USDC as the cash leg. */
export function agentAssets(n: NetworkDef, universe: string[]): { symbol: string; id: string; decimals: number }[] {
  const all = [n.native, ...n.tokens];
  const pick = (sym: string) => { const a = all.find((x) => x.symbol === sym); if (!a) throw new UserError('unsupported_asset', `${sym} is not tradable on ${n.name} in the wallet registry`); return { symbol: a.symbol, id: a.id, decimals: a.decimals }; };
  return [pick('USDC'), ...universe.filter((s) => s !== 'USDC').map(pick)];
}
const load = async (id: string): Promise<AgentRow> => {
  if (!z.uuid().safeParse(id).success) throw new UserError('not_found', 'agent not found', 404);
  const [a] = await sql<AgentRow[]>`select * from agents where id = ${id}`;
  if (!a) throw new UserError('not_found', 'agent not found', 404);
  return a;
};
export async function vaultBalances(a: AgentRow): Promise<{ symbol: string; id: string; decimals: number; amount: bigint }[]> {
  const n = getNetwork(a.network), b = await adapterFor(a.network).balances(a.vault_address);
  const gas = { symbol: n.native.symbol, id: 'native', decimals: n.native.decimals };
  const list = agentAssets(n, a.universe); if (!list.some((x) => x.id === 'native')) list.push(gas);
  return list.map((x) => ({ ...x, amount: b[x.id] ?? 0n }));
}
const view = (a: AgentRow) => ({ id: a.id, name: a.name, mission: a.mission, state: a.state, mode: a.mode, network: a.network, networkName: getNetwork(a.network).name, universe: a.universe, interval: a.interval, risk: a.risk,
  vaultAddress: a.vault_address, vaultIndex: a.vault_index, capitalUsdc: formatUnits(BigInt(a.capital_usdc), 6), strategyVersionId: a.strategy_version_id, mandateId: a.mandate_id,
  mandate: a.mandate ? { expiresAt: a.mandate.expiresAt, label: a.mandate.label, strategySha256: a.mandate.strategySha256, maxOrdersPerDay: a.mandate.maxOrdersPerDay } : null,
  lastBar: a.last_bar, stopReason: a.stop_reason, createdAt: a.created_at, updatedAt: a.updated_at });

/** Build the mandate from the agent's risk settings: USD caps become per-asset base-unit caps at current prices. */
export function mandateFor(a: AgentRow, keyId: string, strategySha256: string, prices: Record<string, number>, now: number): Mandate {
  const n = getNetwork(a.network), assets = agentAssets(n, a.universe);
  const cap = (usd: number, x: { symbol: string; decimals: number }) => { const p = x.symbol === 'USDC' ? 1 : prices[x.symbol]; if (!p || !(p > 0)) throw new UserError('no_price', `no market price for ${x.symbol}; cannot size the mandate`, 503);
    return parseUnits((usd / p).toFixed(Math.min(x.decimals, 8)), x.decimals).toString(); };
  const m: Mandate = { v: 1, mandateId: randomUUID(), keyId, vaultIndex: a.vault_index, vault: a.vault_address, network: a.network, provider: 'kyberswap', assets: assets.map((x) => x.id),
    maxOrder: Object.fromEntries(assets.map((x) => [x.id, cap(a.risk.maxOrderUsd, x)])), maxDaily: Object.fromEntries(assets.map((x) => [x.id, cap(a.risk.maxDailyUsd, x)])),
    maxOrdersPerDay: a.risk.maxOrdersPerDay, maxSlippageBps: Math.min(500, Math.max(150, a.risk.slippageBps + 80)), createdAt: now, expiresAt: now + a.risk.mandateDays * 86400, strategySha256, label: a.name.slice(0, 60) };
  validateMandate(MandateSchema.parse(m), now);
  return m;
}

export function agentRoutes(app: FastifyInstance, deps: { prices: () => Promise<Record<string, { usd: number }> | null> }): void {
  app.get('/api/v1/agents', async () => ({ agents: (await sql<AgentRow[]>`select * from agents order by created_at desc`).map(view) }));

  app.post('/api/v1/agents', async (req) => {
    const b = Create.parse(req.body);
    const n = getNetwork('base');
    if (!KYBER_ENABLED[n.id]) throw new UserError('unsupported_network', 'agents trade on Base only for now', 422);
    agentAssets(n, b.universe); // every symbol must be a registry asset on the network
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const id = randomUUID();
    const [row] = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7707002)`;
      const rows = await tx<{ next: number }[]>`select coalesce(max(vault_index), 0) + 1 as next from agents`;
      const next = rows[0]!.next;
      const { address } = await signer.vaultAddress(next); // derived by the signer; the API never chooses it
      return tx<AgentRow[]>`insert into agents (id, name, mission, universe, interval, risk, vault_index, vault_address, capital_usdc)
        values (${id}, ${b.name}, ${b.mission}, ${tx.json(b.universe)}, ${b.interval}, ${tx.json(b.risk as never)}, ${next}, ${address}, ${parseUnits(b.capitalUsdc, 6).toString()}) returning *`;
    });
    await audit('agent.created', 'owner', { id, name: b.name, vault: row!.vault_address, vaultIndex: row!.vault_index, universe: b.universe });
    return view(row!);
  });

  app.get('/api/v1/agents/:id', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const px = await deps.prices();
    const balances = await vaultBalances(a).catch(() => null);
    const usd = (sym: string, amt: bigint, dec: number) => { const p = sym === 'USDC' ? 1 : px?.[sym]?.usd; return p === undefined ? null : Number(formatUnits(amt, dec)) * p; };
    const versions = await sql`select id, name, version, code_sha256, status, notes, created_at, approved_at, report->'metrics' as metrics, report->'robustness' as robustness, report->'benchmarks' as benchmarks, report->'config' as config from strategy_versions where agent_id = ${a.id} order by created_at desc`;
    const orders = await sql`select id, ts, mode, from_symbol, to_symbol, amount_in, expected_out, min_out, received, state, reason, txid from agent_orders where agent_id = ${a.id} order by ts desc limit 60`;
    const equity = await sql`select ts, mode, equity_usd from agent_equity where agent_id = ${a.id} order by ts desc limit 500`;
    const log = await sql`select ts, kind, title, body from research_log where agent_id = ${a.id} order by ts desc limit 40`;
    const st = await signer.status().catch(() => null);
    const sm = st?.mandates?.find((m) => m.mandate.mandateId === a.mandate_id) ?? null;
    return { ...view(a),
      vault: balances ? balances.map((x) => ({ symbol: x.symbol, asset: x.id, amount: x.amount.toString(), display: formatUnits(x.amount, x.decimals), usd: usd(x.symbol, x.amount, x.decimals) })) : null,
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
    const px = await deps.prices();
    const mandate = mandateFor(a, st.keyId, v!.code_sha256, Object.fromEntries(Object.entries(px ?? {}).map(([k, p]) => [k, p.usd])), Math.floor(Date.now() / 1000));
    const hash = mandateHash(mandate);
    await sql`update agents set mandate = ${sql.json(mandate as never)}, updated_at = now() where id = ${a.id}`;
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 120_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    const n = getNetwork(a.network);
    const human = agentAssets(n, a.universe).map((x) => ({ symbol: x.symbol, maxOrder: formatUnits(BigInt(mandate.maxOrder[x.id]!), x.decimals), maxDaily: formatUnits(BigInt(mandate.maxDaily[x.id]!), x.decimals) }));
    return { mandate, hash: toHex(hash), limits: human, options };
  });
  app.post('/api/v1/agents/:id/mandate/approve', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const b = z.object({ assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    if (!a.mandate) throw new UserError('bad_state', 'prepare the mandate first', 409);
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

  // bring funds back: a vault can only pay the owner's own address (enforced by the signer)
  app.post('/api/v1/agents/:id/withdraw', async (req) => {
    const a = await load((req.params as { id: string }).id);
    const b = z.strictObject({ asset: z.string().max(80) }).parse(req.body);
    if (!a.mandate_id) throw new UserError('bad_state', 'this vault has never had a mandate: it cannot hold funds the agent moved', 409);
    if (a.state === 'LIVE') throw new UserError('bad_state', 'revoke the mandate before withdrawing', 409);
    const n = getNetwork(a.network), asset = getAsset(n.id, b.asset), st = await signer.status(true);
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
    const signed = await signer.mandateReturn(a.mandate_id, intent);
    if (config.broadcast) await adapterFor(n.id).broadcast(signed.raw);
    await audit('agent.withdraw', 'owner', { agent: a.id, symbol: asset.symbol, amount: amount.toString(), txid: signed.txid });
    return { ok: true, txid: signed.txid, symbol: asset.symbol, amount: formatUnits(amount, asset.decimals), explorer: n.explorerTx + signed.txid };
  });
}
