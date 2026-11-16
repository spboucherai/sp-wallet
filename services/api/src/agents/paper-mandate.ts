// The PAPER trading mandate of a perp agent (schema SPW-TRADING-MANDATE-v1, mode `paper`).
//
// The unified order service executes an agent's order only under a trading mandate — in paper too. This file creates THAT
// mandate, and only that one: `mode: 'paper'` is a literal below, there is no parameter for it. A paper mandate signs nothing
// and needs no passkey (mandates/service.ts); it is the same schema and the same per-order checks as a live one, enforced by the
// API on the simulated account.
//
// Who: the owner, or an API key holding `agents:manage` when it starts the agent on paper — then INSIDE THE KEY'S OWN LIMITS:
// a key restricted to other venues or instruments is refused, and the key's per-order notional limit caps the mandate's.
// Never the agent: the engines, the runtime and the gateway do not import this file (test: agent-bind-unit, module boundaries).
//
// A mandate is immutable. When the agent's configuration changes what the mandate would say (limits, instruments, strategy
// version, capital), the previous one is revoked (`superseded`) and a new one is created; the id in force is kept on the agent
// row (`runtime.paperMandate`). LIVE never passes here: a live trading mandate is created and approved by the owner with the
// passkey (agents/mandate-write.ts → mandates/service.ts).
import { createHash } from 'node:crypto';
import { D, type DecStr } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { journal } from '../agent-runtime/journal.ts';
import { execution } from './execution-bind.ts';
import type { PerpRisk } from './perp-engine.ts';

export interface PaperMandateRef { id: string; spec: string; at: number; by: string }
interface AgentLike { id: string; name: string; kind?: string | null | undefined; universe: string[]; risk: unknown; capital_usdc: string | bigint | number; deriv_account_id?: string | null; strategy_version_id?: string | null; runtime?: unknown }
const usd = (x: ReturnType<typeof D.from>): DecStr => D.str(D.quantize(x, D.from('0.01'), 'up'));
const pct = (n: number): ReturnType<typeof D.from> => D.div(D.from(String(n)), D.from('100'), 8, 'down');

/** the longest a trading mandate lasts (packages/trading: 90 days). A paper agent that runs longer is started again (the mandate is then renewed). */
export const PAPER_MANDATE_DAYS = 90;
export const paperMandateOf = (a: { runtime?: unknown }): PaperMandateRef | null => ((a.runtime as { paperMandate?: PaperMandateRef } | null)?.paperMandate ?? null);

/** The mandate that says what the agent's own limits say — nothing wider. `keyCap`: an API key's per-order notional limit. */
export function paperMandateBody(a: AgentLike, strategySha256: string, keyCap: number | null = null) {
  const r = a.risk as PerpRisk, capital = D.div(D.from(String(a.capital_usdc)), D.from('1000000'), 6, 'down');
  const posCap = D.mul(capital, D.from(String(r.maxPositionX)));
  const orderCap = keyCap !== null && D.lt(D.from(String(keyCap)), posCap) ? D.from(String(keyCap)) : posCap;
  return {
    principal: { kind: 'agent' as const, id: a.id }, mode: 'paper' as const, accountIds: [a.deriv_account_id!], instruments: a.universe.map((s) => `hyperliquid:${s}`), marketKinds: ['perp' as const], orderTypes: ['market' as const],
    // collateral the agent may put at risk: its simulated capital (margin in use never exceeds the gross exposure it may hold)
    maxCapitalUsd: usd(D.mul(capital, D.max(D.one, D.from(String(r.maxGrossExposureX))))), maxOrderNotionalUsd: usd(orderCap), maxPositionNotionalUsd: usd(posCap), maxLeverage: String(r.maxLeverage),
    maxDailyLossUsd: usd(D.mul(capital, pct(r.maxDailyLossPct))), floorEquityUsd: D.str(D.quantize(D.max(D.zero, D.mul(capital, D.sub(D.one, pct(r.maxTotalLossPct)))), D.from('0.01'), 'down')),
    days: PAPER_MANDATE_DAYS, frequency: { perMinute: 40, perHour: 400, perDay: 400 }, maxSlippageBps: Math.min(2000, Math.max(1, r.slippageBps)),
    // the fee cap an agent order names is 0.2 % of its notional (perp-gateway.ts `feeCap`)
    maxFeeUsd: usd(D.add(D.mul(orderCap, D.from('0.002')), D.from('0.01'))), stopConditions: [], strategySha256, label: `paper · ${a.name}`.slice(0, 60), locale: 'en' as const,
  };
}
const specOf = (body: ReturnType<typeof paperMandateBody>): string => createHash('sha256').update(JSON.stringify({ ...body, label: null })).digest('hex');

/** what an API key may give a paper agent: nothing outside its own restrictions, and at most its own per-order limit */
async function keyBounds(actor: string, instruments: string[]): Promise<number | null> {
  if (actor === 'owner') return null;
  const id = actor.startsWith('key:') ? actor.slice(4) : '';
  const [k] = id ? await sql<{ limits: { maxOrderNotionalUsd?: number | null } | null; restrictions: { venues?: string[]; instruments?: string[]; networks?: string[] } | null; scopes: string[] }[]>`select limits, restrictions, scopes from api_keys where id = ${id} and revoked_at is null and expires_at > now()` : [];
  if (!k) throw new UserError('forbidden', 'a paper mandate is created by the owner, or by an active API key that starts the agent on paper', 403);
  if (!k.scopes.includes('agents:manage')) throw new UserError('insufficient_scope', 'creating an agent\'s paper mandate needs the scope agents:manage', 403);
  const x = k.restrictions ?? {};
  if (x.venues?.length && !x.venues.includes('hyperliquid')) throw new UserError('restricted', 'this key is not allowed on venue hyperliquid: it cannot start this agent on paper', 403);
  const off = x.instruments?.length ? instruments.filter((i) => !x.instruments!.includes(i)) : [];
  if (off.length) throw new UserError('restricted', `this key is not allowed on ${off.join(', ')}: it cannot start this agent on paper`, 403);
  const cap = k.limits?.maxOrderNotionalUsd;
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** The paper mandate in force for this perp agent, created (and the previous one superseded) when its configuration asks for another. */
export async function ensurePaperMandate(a: AgentLike, actor: string): Promise<PaperMandateRef> {
  if ((a.kind ?? 'spot') !== 'perp' || !a.deriv_account_id) throw new UserError('wrong_kind', 'only a perp agent with a paper account has a paper trading mandate', 409);
  const [v] = a.strategy_version_id ? await sql<{ code_sha256: string; status: string }[]>`select code_sha256, status from strategy_versions where id = ${a.strategy_version_id}` : [];
  if (!v || v.status !== 'approved') throw new UserError('no_strategy', 'approve a strategy version first', 409);
  const ex = execution(), body = paperMandateBody(a, v.code_sha256, await keyBounds(actor, a.universe.map((s) => `hyperliquid:${s}`))), spec = specOf(body), cur = paperMandateOf(a);
  if (cur && cur.spec === spec) {
    const m = await ex.mandates.get(cur.id).catch(() => null);
    // still in force for at least a day: nothing to do
    if (m && m.state === 'active' && m.phase === 'active' && m.notAfter > ex.mandates.now() + 86_400_000) return cur;
  }
  const created = await ex.mandates.create(body);
  await ex.mandates.approve(created.id, {});                                     // paper: no signer, no passkey — nothing is signed
  const ref: PaperMandateRef = { id: created.id, spec, at: ex.mandates.now(), by: actor };
  await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ paperMandate: ref } as never)}, updated_at = now() where id = ${a.id}`;
  if (cur) await ex.mandates.revoke(cur.id, { by: actor === 'owner' ? 'owner' : 'system', reason: 'superseded', detail: `superseded by ${created.id}`, cancelOpenOrders: false }).catch((e: Error) => console.error(`[agents] paper mandate ${cur.id} not revoked: ${e.message}`));
  await audit('agent.paper_mandate', actor, { agent: a.id, mandateId: created.id, hash: created.hash, superseded: cur?.id ?? null, maxOrderNotionalUsd: body.maxOrderNotionalUsd, instruments: body.instruments });
  await journal(a.id, { mode: 'PAPER', kind: 'mandate', code: 'paper_mandate', title: `Paper trading mandate ${cur ? 'replaced' : 'created'} by ${actor}`,
    body: `mandate ${created.id} (SPW-TRADING-MANDATE-v1, paper: nothing is signed) — ${body.instruments.join(', ')}; at most ${body.maxOrderNotionalUsd} USD per order, ${body.maxPositionNotionalUsd} USD per position, leverage ${body.maxLeverage}` }).catch(() => {});
  return ref;
}

/** stop of a paper agent: its paper mandate ends with it */
export async function revokePaperMandate(a: { id: string; runtime?: unknown }, actor: string): Promise<void> {
  const cur = paperMandateOf(a);
  if (!cur) return;
  await execution().mandates.revoke(cur.id, { by: actor === 'owner' ? 'owner' : 'system', reason: 'owner_request', detail: `agent stopped by ${actor}`, cancelOpenOrders: true }).catch(() => {});
  await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) - 'paperMandate', updated_at = now() where id = ${a.id}`;
}
