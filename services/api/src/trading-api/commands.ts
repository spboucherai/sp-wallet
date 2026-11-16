// POST /api/v1/trading/commands — one line of the deterministic command grammar of @spw/trading (`interpret`): no model, no guess.
//
// The scope is the one of the operation the command RESOLVES to, checked here (the route itself only asks for `orders:prepare`).
// What the grammar leaves open — venue, network, leverage, margin mode, fee cap, slippage bound, order validity — comes from the
// owner's stored defaults (`trading.command_defaults`, GET/PUT /api/v1/developer/command-defaults, owner session only) and from
// nothing else: a command they do not settle answers 409 `ambiguous_command` with the questions, and nothing is executed.
// An order goes to the order service like any other (mandate, risk engine, venue engine).
import { z } from 'zod';
import type { DecStr } from '@spw/derivatives';
import { interpret, parseCommand, type Catalog, type CatalogInstrument, type Command, type ResolutionDefaults } from '@spw/trading';
import { UserError } from '../config.ts';
import { getSetting, setSetting, sql } from '../db.ts';
import type { Caller, Execution } from '../orders/index.ts';
import type { Principal } from './principal.ts';
import type { Reads } from './read.ts';
import type { Scope } from './spec.ts';

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), Asset = z.string().regex(/^[A-Za-z0-9.]{1,15}$/), Dec = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/);
/** every member optional: what is absent is ASKED, never assumed (packages/trading/src/commands/parse.ts ResolutionDefaults) */
export const CommandDefaultsSchema = z.strictObject({
  spotNetwork: Id.optional(), spotVenueByNetwork: z.record(Id, Id).optional(), spotQuote: Asset.optional(), usdQuotes: z.array(Asset).max(10).optional(),
  perpVenue: Id.optional(), perpNetworkByVenue: z.record(Id, Id).optional(), perpLeverage: Dec.optional(), perpMarginMode: z.enum(['cross', 'isolated']).optional(),
  maxFeeBps: z.number().int().min(0).max(10_000).optional(), maxSlippageBps: z.number().int().min(1).max(500).optional(), orderTtlMs: z.number().int().min(1_000).max(86_400_000).optional(),
});
const KEY = 'trading.command_defaults';
export const commandDefaults = async (): Promise<ResolutionDefaults> => CommandDefaultsSchema.parse(await getSetting(KEY, {})) as ResolutionDefaults;
export async function setCommandDefaults(raw: unknown): Promise<ResolutionDefaults> { const v = CommandDefaultsSchema.parse(raw); await setSetting(KEY, v); return v as ResolutionDefaults; }


/** what the wallet itself knows, for one perp asset: the instruments on the venues it can trade, its positions, the venue marks */
async function perpCatalog(ex: Execution, mode: 'paper' | 'live', asset: string, accountId: string | undefined): Promise<Catalog> {
  const d = ex.orders.deps.derivatives(), instruments: CatalogInstrument[] = [], referencePricesUsd: Record<string, DecStr> = {}, positions: { instrument: string; side: 'long' | 'short'; size: DecStr }[] = [];
  const all = mode === 'paper' ? await sql<{ id: string; venue: string; network: string }[]>`select id, venue, network from deriv_paper_accounts`
    : await sql<{ id: string; venue: string; network: string }[]>`select id, venue, network from deriv_accounts where authorization_id is not null`;
  const accounts = accountId ? all.filter((a) => a.id === accountId) : all;                 // a named account: its positions only
  for (const v of d.registry.list()) {
    if (v.restriction !== null) continue;                                  // never tradable from this wallet: not even a candidate
    const list = await d.data.instruments(v.id).then((s) => s.value, () => []);
    const networks = [...new Set(accounts.filter((a) => a.venue === v.id).map((a) => a.network))];
    for (const i of list.filter((x) => x.base.toUpperCase() === asset)) {
      for (const network of networks.length ? networks : [v.adapter.network]) instruments.push({ id: i.id, venue: v.id, network, marketKind: 'perp', base: i.base.toUpperCase(), quote: i.quote, lotSize: i.lotSize });
      const t = await d.data.ticker(i).catch(() => null);
      if (t) referencePricesUsd[i.id] = t.mark;
    }
  }
  if (mode === 'paper') { for (const a of await d.paper.list()) if (accounts.some((x) => x.id === a.id)) for (const p of a.positions) positions.push({ instrument: p.instrument, side: p.side, size: p.size }); }
  else for (const a of accounts) { const s = await ex.orders.deps.live().mandateAccountState(a.id).catch(() => null); for (const p of s?.positions ?? []) positions.push({ instrument: p.instrument, side: p.side, size: p.size }); }
  return { instruments, positions, referencePricesUsd };
}


// ---------------------------------------------------------------------------------------------------------------- the guard
// The route of POST /commands is declared with the scope `orders:prepare` only, because the operation is not known before the
// line is parsed. What a command may do is decided HERE, in ONE place, for every command kind:
//
//   parse  →  commandOperation(command, dryRun)  →  CommandGrant.authorize(principal, …)  →  EXECUTORS[kind](grant, …)
//
// An executor takes a `CommandGrant`, and a grant can only be made by `CommandGrant.authorize` (its constructor is private):
// there is no way to run an executor — today's or one written later — without the scope and mandate check having passed for
// exactly that command. `commandOperation` is an exhaustive switch and `EXECUTORS` an exhaustive table over `Command['type']`:
// a new command kind does not compile until it has an operation (a scope) and an executor.
export type CommandKind = Command['type'];
/** what a command resolves to: the scope a key must hold, and whether the key must be bound to a trading mandate */
export interface CommandOperation { scope: Scope; needsMandate: boolean }
export function commandOperation(c: Command, dryRun: boolean): CommandOperation {
  switch (c.type) {
    case 'spot_buy': case 'spot_sell': return { scope: dryRun ? 'orders:prepare' : 'orders:execute', needsMandate: false };   // a key is refused spot execution by the executor, with its own code
    case 'perp_open': return { scope: dryRun ? 'orders:prepare' : 'orders:execute', needsMandate: true };
    case 'perp_close': return { scope: dryRun ? 'orders:prepare' : 'positions:manage', needsMandate: true };
    case 'cancel_order': case 'cancel_all': return { scope: 'orders:cancel', needsMandate: false };                          // a cancel only removes what could still execute
    case 'show': return { scope: c.topic === 'positions' || c.topic === 'risk' ? 'positions:read' : c.topic === 'balances' ? 'wallet:read' : 'orders:read', needsMandate: false };
    case 'stop_all_agents': return { scope: 'agents:manage', needsMandate: false };
    case 'kill': return { scope: 'positions:manage', needsMandate: false };
    default: { const never: never = c; throw new Error(`no operation is declared for the command ${JSON.stringify(never)}`); }
  }
}
export class CommandGrant<C extends Command = Command> {
  private constructor(readonly command: C, readonly operation: CommandOperation, readonly dryRun: boolean) {}
  /** the ONE check. The owner's session holds every scope; a key must hold the scope of the operation the command resolves to, and a mandate when that operation needs one. */
  static authorize<C extends Command>(p: Principal, mandateId: string | null, command: C, dryRun: boolean): CommandGrant<C> {
    const operation = commandOperation(command, dryRun);
    if (p.kind === 'api_key') {
      if (!p.scopes.includes(operation.scope)) throw new UserError('insufficient_scope', `this key lacks the scope ${operation.scope}, which this command needs`, 403);
      if (operation.needsMandate && !mandateId) throw new UserError('mandate_required', 'this key has no trading mandate: an order command cannot execute', 403);
    } else if (p.kind !== 'owner') throw new UserError('unauthenticated', 'authentication required', 401);
    return new CommandGrant(command, operation, dryRun);
  }
}
interface Ctx { ex: Execution; reads: Reads; p: Principal; caller: Caller; body: { text: string; mode: 'paper' | 'live'; accountId?: string | undefined; dryRun: boolean }; idemKey: string; base: { command: CommandKind; mode: 'paper' | 'live'; dryRun: boolean } }
type Out = Promise<Record<string, unknown>>;
type Executor<K extends CommandKind> = (g: CommandGrant<Extract<Command, { type: K }>>, x: Ctx) => Out;

const show: Executor<'show'> = async ({ command }, { ex, reads, p, caller, body, base }) => {
  const data = command.topic === 'positions' ? await reads.positions(p, { mode: body.mode }) : command.topic === 'balances' ? await reads.balances(p, {})
    : command.topic === 'orders' ? { orders: await ex.orders.list(caller, { mode: body.mode, open: 'true', limit: 100 }) } : { ...(await reads.risk(p)), engine: await ex.risk.switches() };
  return { ...base, kind: 'query', query: command.topic, data };
};
const kill: Executor<'kill'> = async (_g, { ex, p, body, base }) => {
  if (body.dryRun) return { ...base, kind: 'control', control: { type: 'kill_switch_on' }, executed: false };
  const s = await ex.risk.engageKillSwitch(p.kind === 'owner' ? { kind: 'owner', id: 'owner' } : { kind: 'api_key', id: p.id }, 'KILL command');
  return { ...base, kind: 'control', control: { type: 'kill_switch_on' }, executed: true, killSwitch: s.killSwitch };
};
const stopAllAgents: Executor<'stop_all_agents'> = async () => {
  throw new UserError('execution_not_wired', 'STOP ALL AGENTS is declared but not connected yet (agents runtime); nothing was done. KILL engages the global kill switch, which stops every new risk of every agent.', 501);
};
const cancelOrder: Executor<'cancel_order'> = async ({ command }, { ex, caller, body, base }) => {
  if (body.dryRun) return { ...base, kind: 'control', control: { type: 'cancel_order', id: command.id }, executed: false };
  return { ...base, kind: 'control', control: { type: 'cancel_order', id: command.id }, executed: true, result: await ex.orders.cancel(caller, command.id) };
};
const cancelAll: Executor<'cancel_all'> = async ({ command }, { ex, p, caller, body, base }) => {
  // a key: its own orders; the owner: every open order of the unified table (of the venue named, if one is)
  const open = (await ex.orders.list(caller, { mode: body.mode, ...(command.venue ? { venue: command.venue } : {}), open: 'true', limit: 500, mine: p.kind !== 'owner' }));
  if (body.dryRun) return { ...base, kind: 'control', control: { type: 'cancel_all', venue: command.venue }, executed: false, orders: open.map((o) => o.id) };
  const results: { id: string; ok: boolean; status?: string; error?: string }[] = [];
  for (const o of open) { try { const r = await ex.orders.cancel(caller, o.orderId); results.push({ id: o.id, ok: true, status: r.order.status }); } catch (e) { results.push({ id: o.id, ok: false, error: e instanceof UserError ? e.code : 'internal' }); } }
  return { ...base, kind: 'control', control: { type: 'cancel_all', venue: command.venue }, executed: true, results };
};
const spot: Executor<'spot_buy'> & Executor<'spot_sell'> = async (_g, { p }) => {
  if (p.kind !== 'owner') throw new UserError('spot_execution_requires_agent_vault', 'spot execution for an API key exists only through an agent vault under a spot mandate (Agents); it is not offered here', 403);
  throw new UserError('spot_via_swap_screen', 'a spot order of the owner is a swap proposal approved with the passkey: prepare it in the Swap screen (not wired to commands in this version)', 422);
};
const perp: Executor<'perp_open'> & Executor<'perp_close'> = async ({ command }, { ex, p, caller, body, idemKey, base }) => {
  const now = ex.orders.now();
  const catalog = await perpCatalog(ex, body.mode, command.asset, body.accountId);
  const r = interpret(body.text, await commandDefaults(), catalog, { now, principal: caller.principal, mandateId: p.kind === 'owner' ? null : caller.mandateId, mode: body.mode, idempotencyKey: idemKey }).resolution!;
  if (r.kind === 'ambiguous') throw Object.assign(new UserError('ambiguous_command', 'the command and the owner\'s defaults do not settle everything: answer the questions (or set the defaults) and send it again. Nothing was executed.', 409), { data: { questions: r.questions } });
  if (r.kind === 'unresolvable') throw new UserError(r.code, r.message, 422);
  if (r.kind !== 'order') throw new UserError('bad_request', 'the command did not resolve to an order', 400);
  const attached = r.attached.map((a) => ({ role: a.role, order: a.order, hash: a.hash, placed: false, note: 'a stop-loss / take-profit is placed only once the entry is filled, sized to what was filled: not placed by this endpoint in this version' }));
  if (body.dryRun) return { ...base, kind: 'order', order: r.order, hash: r.hash, attached, executed: false };
  const out = await ex.orders.submitCanonical(caller, r.order, idemKey, { origin: 'command', strictReduce: command.type === 'perp_close', ...(body.accountId ? { accountId: body.accountId } : {}) });
  return { ...base, kind: 'order', executed: true, ...out, canonical: r.order, hash: r.hash, attached };
};
/** exhaustive: one executor per command kind, each reachable only with a grant */
const EXECUTORS: { [K in CommandKind]: Executor<K> } = { show, kill, stop_all_agents: stopAllAgents, cancel_order: cancelOrder, cancel_all: cancelAll, spot_buy: spot, spot_sell: spot, perp_open: perp, perp_close: perp };
export const COMMAND_KINDS = Object.keys(EXECUTORS) as CommandKind[];

export async function runCommand(ex: Execution, reads: Reads, p: Principal, caller: Caller, body: { text: string; mode: 'paper' | 'live'; accountId?: string | undefined; dryRun: boolean }, idemKey: string): Promise<Record<string, unknown>> {
  const parsed = parseCommand(body.text);
  if (!parsed.ok) throw Object.assign(new UserError('parse_error', parsed.error.message, 400), { data: { code: parsed.error.code, token: parsed.error.token } });
  const command = parsed.command;
  const grant = CommandGrant.authorize(p, caller.mandateId, command, body.dryRun);
  const run = EXECUTORS[command.type] as (g: CommandGrant, x: Ctx) => Out;
  return run(grant, { ex, reads, p, caller, body, idemKey, base: { command: command.type, mode: body.mode, dryRun: body.dryRun } });
}
