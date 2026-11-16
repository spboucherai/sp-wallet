// The engine's real-world side: the signal runner (a sandboxed Python process), live holdings, and the live order path
// prepare → delegated signature (the signer checks the mandate, the calldata and its own prices) → approval → simulation →
// broadcast → receipt. Nothing here holds a key or can widen a limit; a refusal by the signer is final for that order.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { decodeEventLog, hexToNumber, numberToHex } from 'viem';
import { formatUnits, getNetwork, KYBER_ROUTER, KYBER_ROUTER_ABI, vaultKeyId } from '@spw/core';
import { adapterFor } from '../chains/index.ts';
import { rpcAny } from '../chains/rpc.ts';
import { config } from '../config.ts';
import { audit, sql } from '../db.ts';
import { signer } from '../signer-client.ts';
import { kyberQuote, prepareKyberSwap } from '../swap-exec.ts';
import { paperHoldings, tickAgent, type Bar, type EngineDeps, type Holding, type OrderRef, type PlannedOrder } from './engine.ts';
import { uuidFrom } from './spot-seam.ts';
import { gasReserve } from './gas.ts';
import { labExec, RESEARCH_DIR, SIGNAL_MAX_RSS_MB } from './lab.ts';
import { engineLoop } from '../loop-stats.ts';
import { vaultBalances, type AgentRow } from './routes.ts';

// v8: RESEARCH_DIR lives in lab.ts (the sandboxed laboratory runner); re-exported here for the modules that import it from live.ts
export { RESEARCH_DIR };
const SIGNAL_TIMEOUT_MS = 60_000;

/** Run the approved strategy in a separate, OS-sandboxed process (lab.ts: no network, read-only laboratory + this one strategy
 *  directory, a scratch directory, no fork) with an almost empty environment. Any deviation throws (→ hold). */
export async function runSignal(strategy: { path: string; sha256: string }, data: Record<string, Bar[]>, interval: string): Promise<Record<string, number>> {
  const dir = path.resolve(RESEARCH_DIR, strategy.path);
  if (!dir.startsWith(path.join(RESEARCH_DIR, 'strategies') + path.sep) || !existsSync(path.join(dir, 'strategy.py'))) throw new Error('strategy directory is not inside research/strategies');
  if (!/^[0-9a-f]{64}$/.test(strategy.sha256)) throw new Error('bad strategy hash');
  // identical timestamps for every symbol: keep only the bars all of them have (the runner refuses a series with real gaps)
  const syms = Object.keys(data), common = syms.map((s) => new Set(data[s]!.map((b) => b.ts))).reduce((x, y) => new Set([...x].filter((t) => y.has(t))));
  const candles = Object.fromEntries(syms.map((s) => [s, data[s]!.filter((b) => common.has(b.ts)).map((b) => [Math.floor(b.ts / 1000), b.open, b.high, b.low, b.close, b.volume])]));
  const last = Math.max(...common);
  const input = JSON.stringify({ candles, interval, as_of: new Date(last).toISOString().replace('.000Z', 'Z') });
  let r;
  try { r = await labExec(['spq.signal', '--strategy', dir, '--sha256', strategy.sha256, '--input', '-'], { timeoutMs: SIGNAL_TIMEOUT_MS, stdin: input, strategyDir: dir, maxOut: 100_000, onOverflow: 'kill', maxRssMb: SIGNAL_MAX_RSS_MB }); }
  catch (e) { throw new Error(`signal runner could not start: ${(e as Error).message}`); }
  if (r.killed === 'timeout') throw new Error('signal timed out');
  if (r.killed === 'output') throw new Error('signal output too large');
  if (r.killed === 'memory') throw new Error('signal used too much memory');
  if (r.code === null) throw new Error(`signal runner could not start: ${r.err.trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
  if (r.code !== 0) throw new Error(`signal exit ${r.code}: ${r.err.trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
  try {
    const j = JSON.parse(r.out) as { strategy_sha256?: string; as_of?: string; weights?: Record<string, number> };
    if (j.strategy_sha256 !== strategy.sha256) throw new Error('signal computed by another strategy hash');
    if (!j.as_of || Date.parse(j.as_of) !== last) throw new Error('signal is not for the last closed bar');
    if (!j.weights || typeof j.weights !== 'object') throw new Error('no weights');
    return j.weights;
  } catch (e) { throw new Error(`unreadable signal: ${(e as Error).message}`); }
}

/** The agent's own assets in the vault. The gas reserve of the network (gas.ts: sized from recent gas prices and the signer
 *  policy's fee ceiling) is kept out of the strategy's reach, so the vault can always pay to sell and to withdraw; the
 *  native coin held only for gas is not a holding at all. Throws when the reserve cannot be computed (the engine then holds). */
export async function liveHoldings(a: AgentRow): Promise<Holding[]> {
  const n = getNetwork(a.network), list = (await vaultBalances(a)).filter((x) => x.role !== 'gas');
  const reserve = list.some((x) => x.id === 'native') ? (await gasReserve(n, (await signer.status()).policy.maxFee[n.id])).reserve : 0n;
  return list.map((x) => { const amount = x.id === 'native' ? (x.amount > reserve ? x.amount - reserve : 0n) : x.amount; return { symbol: x.symbol, id: x.id, decimals: x.decimals, units: Number(formatUnits(amount, x.decimals)) }; });
}

const OPEN = ['prepared', 'signed', 'broadcast'];
interface OrderRow { id: string; agent_id: string; ts: Date; state: string; from_asset: string; amount_in: string; txid: string | null; pre_txid: string | null; raw: string | null; pre_raw: string | null; aux: { swapData?: string; usd?: number; preState?: string } | null }
const setState = (id: string, state: string, reason?: string) => sql`update agent_orders set state = ${state}, reason = coalesce(${reason ?? null}, reason), updated_at = now() where id = ${id}`;

/** Prepare one live order for the vault and obtain the delegated signature. The order row exists before anything is signed. */
export async function placeLive(a: AgentRow, o: PlannedOrder, bar: number, ref?: OrderRef): Promise<void> {
  if (!a.mandate_id || !a.mandate) throw new Error('no mandate');
  const n = getNetwork(a.network), st = await signer.status(true);
  if (st.halted) throw new Error('emergency halt is active');
  const id = ref ? uuidFrom(ref.clientOrderId) : randomUUID();   // V11: derived from the client order id — the same order cannot be recorded twice
  const ps = await prepareKyberSwap({ n, me: a.vault_address, keyId: vaultKeyId(st.keyId, a.vault_index), fromAsset: o.fromId, toAsset: o.toId, amount: o.amountIn, slippageBps: a.risk.slippageBps, policyVersion: st.policy.version, proposalId: id, ttlSec: 120 });
  await sql`insert into agent_orders (id, agent_id, mode, from_asset, to_asset, from_symbol, to_symbol, amount_in, expected_out, min_out, state, reason, bar, intent, aux, client_order_id, signal_id, config_version, strategy_sha256)
    values (${id}, ${a.id}, 'LIVE', ${o.fromId}, ${o.toId}, ${o.fromSymbol}, ${o.toSymbol}, ${o.amountIn.toString()}, ${ps.expected.toString()}, ${ps.minOut.toString()}, 'prepared', ${o.reason}, ${new Date(bar)}, ${sql.json(ps.intent as never)}, ${sql.json({ swapData: ps.data, usd: o.usd })},
      ${ref?.clientOrderId ?? null}, ${ref?.signalId ?? null}, ${ref?.configVersion ?? null}, ${ref?.strategySha256 ?? null})`;
  let signed;
  try { signed = await signer.mandateSign(a.mandate_id, ps.intent, { swapData: ps.data }, { reducesRisk: o.toSymbol === (a.cash ?? 'USDC') }); }
  catch (e) { await setState(id, 'failed', `refused by the signer: ${(e as Error).message.slice(0, 200)}`); await audit('agent.order_refused', 'signer', { agent: a.id, id, reason: (e as Error).message.slice(0, 200) }); throw e; }
  await sql`update agent_orders set state = 'signed', raw = ${signed.raw}, txid = ${signed.txid}, pre_raw = ${signed.pre?.raw ?? null}, pre_txid = ${signed.pre?.txid ?? null}, updated_at = now() where id = ${id}`;
  await audit('agent.order_signed', 'engine', { agent: a.id, id, from: o.fromSymbol, to: o.toSymbol, amount: o.amountIn.toString(), minOut: ps.minOut.toString(), txid: signed.txid });
}

type Receipt = { status: `0x${string}`; logs: { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` }[] } | null;
/** Move one open live order forward by at most one step. Mirrors advanceSwap for the owner's swaps. */
export async function advanceOrder(a: AgentRow, r: OrderRow, now = Date.now()): Promise<void> {
  const n = getNetwork(a.network), ad = adapterFor(a.network), age = now - r.ts.getTime();
  const receipt = (txid: string) => rpcAny<Receipt>(n.rpc, 'eth_getTransactionReceipt', [txid]).catch(() => undefined);
  if (r.state === 'prepared') { if (age > 3 * 60_000) await setState(r.id, 'failed', 'never signed'); return; }
  if (!r.raw || !r.txid) return void (await setState(r.id, 'failed', 'incomplete order'));
  if (r.state === 'signed') {
    if (!config.broadcast) return void (await setState(r.id, 'failed', 'broadcast is disabled on this server; nothing was sent'));
    if (age > 9 * 60_000) return void (await setState(r.id, 'failed', 'the order could not be sent in time; nothing was swapped')); // the calldata deadline is 10 minutes
    if (r.pre_raw && r.aux?.preState !== 'confirmed') {
      await ad.broadcast(r.pre_raw).catch(() => {});
      const rc = await receipt(r.pre_txid!);
      if (!rc) return;
      if (hexToNumber(rc.status) !== 1) return void (await setState(r.id, 'failed', 'the token approval reverted; nothing was swapped'));
      await sql`update agent_orders set aux = aux || '{"preState":"confirmed"}'::jsonb, updated_at = now() where id = ${r.id}`;
    }
    const sim = await rpcAny<string>(n.rpc, 'eth_call', [{ from: a.vault_address, to: KYBER_ROUTER, data: r.aux?.swapData, value: numberToHex(r.from_asset === 'native' ? BigInt(r.amount_in) : 0n) }, 'latest']).then(() => null, (e: Error & { rpcCode?: number }) => (e.rpcCode !== undefined ? e.message : 'unreachable'));
    if (sim === 'unreachable') return;
    if (sim !== null) return void (await setState(r.id, 'failed', `the swap would revert now (${sim.slice(0, 100)}); it was not sent`));
    await ad.broadcast(r.raw);
    await setState(r.id, 'broadcast');
    return;
  }
  if (r.state === 'broadcast') {
    const rc = await receipt(r.txid);
    if (rc === undefined) return;
    if (!rc) { if (age > 20 * 60_000) await setState(r.id, 'failed', 'not included before its deadline'); else await ad.broadcast(r.raw).catch(() => {}); return; }
    if (hexToNumber(rc.status) !== 1) return void (await setState(r.id, 'failed', 'the swap reverted on-chain; only the network fee was spent'));
    let got: bigint | null = null;
    for (const l of rc.logs) { if (l.address.toLowerCase() !== KYBER_ROUTER.toLowerCase()) continue;
      try { const ev = decodeEventLog({ abi: KYBER_ROUTER_ABI, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: { dstReceiver: string; returnAmount: bigint } };
        if (ev.eventName === 'Swapped' && ev.args.dstReceiver.toLowerCase() === a.vault_address.toLowerCase()) got = ev.args.returnAmount; } catch { /* another event */ } }
    await sql`update agent_orders set state = 'filled', received = ${got?.toString() ?? null}, updated_at = now() where id = ${r.id}`;
    await audit('agent.order_filled', 'chain', { agent: a.id, id: r.id, txid: r.txid, received: got?.toString() ?? null });
  }
}

export interface MarketDeps { series(symbol: string, interval: string, limit: number): Promise<Bar[]>; assertFresh(symbol: string, interval: string): Promise<void> }
export function engineDeps(m: MarketDeps, a0?: AgentRow): EngineDeps {
  return {
    series: m.series, assertFresh: m.assertFresh,
    signal: (s, data) => runSignal(s, data, a0?.interval ?? '1h'),
    holdings: (a, mode) => (mode === 'LIVE' ? liveHoldings(a) : paperHoldings(a)),
    quote: (a, from, to, amt) => kyberQuote(getNetwork(a.network), from, to, amt),
    placeLive,
    inFlight: async (a) => (await sql`select 1 from agent_orders where agent_id = ${a.id} and mode = 'LIVE' and state in ${sql(OPEN)} limit 1`).length > 0,
    halted: async () => (await signer.status()).halted,
    revokeMandate: async (a, reason) => { await revokeAgentMandate(a, reason); },
    now: () => Date.now(),
  };
}

/** what the mandate reconciliation needs from the signer (the real client, or a fake in tests) */
export interface MandatePort {
  status(): Promise<{ mandates?: { mandate: { mandateId: string; vaultIndex: number }; approvedAt: string; revoked: boolean; expired: boolean }[] }>;
  mandateRevoke(mandateId: string): Promise<unknown>;
}
/**
 * V11 (D2) — revoke an agent's mandate at the signer because the agent is no longer LIVE (stopped by the engine or by the owner,
 * paused, loss limit, expiry). Revocation needs no passkey: it only removes authority. It never throws: when the signer cannot
 * be reached the failure is recorded and `revokeStaleMandates` — every engine pass — does it as soon as the signer answers.
 */
export async function revokeAgentMandate(a: Pick<AgentRow, 'id' | 'mandate_id'>, reason: string, port: MandatePort = signer): Promise<boolean> {
  if (!a.mandate_id) return true;
  try {
    await port.mandateRevoke(a.mandate_id);
    await audit('mandate.revoked', 'engine', { agent: a.id, mandateId: a.mandate_id, reason: reason.slice(0, 200) });
    return true;
  } catch (e) {
    const m = (e as Error).message.slice(0, 200);
    if ((e as { code?: string }).code === 'signer_not_found') return true;                    // the signer never stored it: nothing to revoke
    await audit('mandate.revoke_failed', 'engine', { agent: a.id, mandateId: a.mandate_id, reason: reason.slice(0, 200), error: m }).catch(() => {});
    await sql`insert into research_log (agent_id, kind, title, body) values (${a.id}, 'stop', 'Mandate not revoked yet', ${`the signer could not be reached to revoke the mandate (${m}); it is retried every minute`})`.catch(() => {});
    return false;
  }
}
/** a mandate the signer approved this recently may belong to an approval whose database write is still in flight */
const MANDATE_ADOPTION_GRACE_MS = 120_000;
/**
 * The signer's own list decides (nothing is remembered here): every mandate it still holds as active must belong to an agent
 * that is LIVE with exactly that mandate. Any other one — the agent stopped or paused, the revocation failed earlier, the
 * answer of an approval was lost, the agent was deleted — is revoked. Returns the ids revoked.
 */
export async function revokeStaleMandates(port: MandatePort = signer, now = Date.now()): Promise<string[]> {
  let st: Awaited<ReturnType<MandatePort['status']>>;
  try { st = await port.status(); } catch { return []; }                                       // signer unreachable: it signs nothing either; next pass
  const active = (st.mandates ?? []).filter((m) => !m.revoked && !m.expired);
  if (!active.length) return [];
  const agents = await sql<{ id: string; state: string; mandate_id: string | null }[]>`select id, state, mandate_id from agents where mandate_id is not null`;
  const out: string[] = [];
  for (const m of active) {
    const id = m.mandate.mandateId, owner = agents.find((a) => a.mandate_id === id);
    if (owner?.state === 'LIVE') continue;
    if (!owner && now - Date.parse(m.approvedAt) < MANDATE_ADOPTION_GRACE_MS) continue;
    try {
      await port.mandateRevoke(id); out.push(id);
      await audit('mandate.revoked', 'engine', { agent: owner?.id ?? null, mandateId: id, reason: owner ? `the agent is ${owner.state}, not LIVE` : 'no agent holds this mandate' });
    } catch { /* next pass */ }
  }
  return out;
}

const backoff = new Map<string, number>();
/** One agent, one pass: settle its open orders, then let the engine decide. Throws on an error (the caller records it and backs off). */
export async function tickSpotAgentOnce(a: AgentRow, m: MarketDeps, now = Date.now(), port: MandatePort = signer, o: { backingOff?: boolean } = {}): Promise<string> {
  for (const r of await sql<OrderRow[]>`select * from agent_orders where agent_id = ${a.id} and mode = 'LIVE' and state in ${sql(OPEN)} order by ts`) await advanceOrder(a, r, now);
  if (a.state === 'LIVE' && a.mandate && a.mandate.expiresAt * 1000 <= now) {
    await sql`update agents set state = 'STOPPED', stop_reason = 'the mandate expired; approve a new one to continue', updated_at = now() where id = ${a.id}`;
    await revokeAgentMandate(a, 'mandate expired', port);                                   // the signer refuses an expired mandate by itself; revoked as well, so that its record says so
    await audit('agent.stopped', 'engine', { id: a.id, reason: 'mandate expired' }); return 'stopped: mandate expired';
  }
  if (o.backingOff) return 'backing off after an error';             // open orders are still settled and an expired mandate still stops the agent
  return tickAgent(a, engineDeps(m, a));
}
/** the agents the spot engine runs */
export const spotAgentsToTick = (): Promise<AgentRow[]> => sql<AgentRow[]>`select * from agents where state in ('PAPER_TRADING', 'LIVE') and kind = 'spot' order by created_at` as unknown as Promise<AgentRow[]>; // v6: perp agents have their own engine (perp-live.ts)
export const recordSpotTickError = (a: Pick<AgentRow, 'id'>, e: unknown): Promise<unknown> =>
  sql`insert into research_log (agent_id, kind, title, body, severity, code) values (${a.id}, 'hold', 'Order not placed', ${(e as Error).message.slice(0, 300)}, 'error', 'tick_error')`.catch(() => {});

/** One SEQUENTIAL pass over every active agent (the pre-V11 loop, kept for scripts and tests; the server runs the scheduler of
 *  agent-runtime/scheduler.ts, which ticks each agent under its lease, in isolation). Errors never cross agents. */
export async function enginePass(m: MarketDeps, now = Date.now(), port: MandatePort = signer): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await revokeStaleMandates(port, now).catch(() => []);                                       // V11 (D2): before anything is decided
  for (const a of await spotAgentsToTick()) {
    try {
      out[a.id] = await tickSpotAgentOnce(a, m, now, port, { backingOff: (backoff.get(a.id) ?? 0) > now });
    } catch (e) {
      backoff.set(a.id, now + 5 * 60_000); out[a.id] = `error: ${(e as Error).message.slice(0, 160)}`;
      await recordSpotTickError(a, e);
    }
  }
  return out;
}

export function startAgentEngine(m: MarketDeps, everyMs = 60_000): () => void {
  // v8: with a heartbeat in loopStats — the monitoring screen and the `system.worker_failing` alert cover the engine
  return engineLoop('agent-engine', everyMs, () => enginePass(m));
}
