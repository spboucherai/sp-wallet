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

const SCOPE_OF = (c: Command, dryRun: boolean): Scope => {
  switch (c.type) {
    case 'spot_buy': case 'spot_sell': case 'perp_open': return dryRun ? 'orders:prepare' : 'orders:execute';
    case 'perp_close': return dryRun ? 'orders:prepare' : 'positions:manage';
    case 'cancel_order': case 'cancel_all': return 'orders:cancel';
    case 'show': return c.topic === 'positions' || c.topic === 'risk' ? 'positions:read' : c.topic === 'balances' ? 'wallet:read' : 'orders:read';
    case 'stop_all_agents': return 'agents:manage';
    case 'kill': return 'positions:manage';
  }
};

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

export async function runCommand(ex: Execution, reads: Reads, p: Principal, caller: Caller, body: { text: string; mode: 'paper' | 'live'; accountId?: string | undefined; dryRun: boolean }, idemKey: string): Promise<Record<string, unknown>> {
  const now = ex.orders.now();
  const parsed = parseCommand(body.text);
  if (!parsed.ok) throw Object.assign(new UserError('parse_error', parsed.error.message, 400), { data: { code: parsed.error.code, token: parsed.error.token } });
  const command = parsed.command, scope = SCOPE_OF(command, body.dryRun);
  if (p.kind === 'api_key' && !p.scopes.includes(scope)) throw new UserError('insufficient_scope', `this key lacks the scope ${scope}, which this command needs`, 403);
  const base = { command: command.type, mode: body.mode, dryRun: body.dryRun };
  if (command.type === 'show') {
    const data = command.topic === 'positions' ? await reads.positions(p, { mode: body.mode }) : command.topic === 'balances' ? await reads.balances(p, {})
      : command.topic === 'orders' ? { orders: await ex.orders.list(caller, { mode: body.mode, open: 'true', limit: 100 }) } : { ...(await reads.risk(p)), engine: await ex.risk.switches() };
    return { ...base, kind: 'query', query: command.topic, data };
  }
  if (command.type === 'kill') {
    if (body.dryRun) return { ...base, kind: 'control', control: { type: 'kill_switch_on' }, executed: false };
    const s = await ex.risk.engageKillSwitch(p.kind === 'owner' ? { kind: 'owner', id: 'owner' } : { kind: 'api_key', id: p.id }, 'KILL command');
    return { ...base, kind: 'control', control: { type: 'kill_switch_on' }, executed: true, killSwitch: s.killSwitch };
  }
  if (command.type === 'stop_all_agents') throw new UserError('execution_not_wired', 'STOP ALL AGENTS is declared but not connected yet (agents runtime); nothing was done. KILL engages the global kill switch, which stops every new risk of every agent.', 501);
  if (command.type === 'cancel_order') {
    if (body.dryRun) return { ...base, kind: 'control', control: { type: 'cancel_order', id: command.id }, executed: false };
    return { ...base, kind: 'control', control: { type: 'cancel_order', id: command.id }, executed: true, result: await ex.orders.cancel(caller, command.id) };
  }
  if (command.type === 'cancel_all') {
    // a key: its own orders; the owner: every open order of the unified table (of the venue named, if one is)
    const open = (await ex.orders.list(caller, { mode: body.mode, ...(command.venue ? { venue: command.venue } : {}), open: 'true', limit: 500, mine: p.kind !== 'owner' }));
    if (body.dryRun) return { ...base, kind: 'control', control: { type: 'cancel_all', venue: command.venue }, executed: false, orders: open.map((o) => o.id) };
    const results: { id: string; ok: boolean; status?: string; error?: string }[] = [];
    for (const o of open) { try { const r = await ex.orders.cancel(caller, o.orderId); results.push({ id: o.id, ok: true, status: r.order.status }); } catch (e) { results.push({ id: o.id, ok: false, error: e instanceof UserError ? e.code : 'internal' }); } }
    return { ...base, kind: 'control', control: { type: 'cancel_all', venue: command.venue }, executed: true, results };
  }
  if (command.type === 'spot_buy' || command.type === 'spot_sell') {
    if (p.kind !== 'owner') throw new UserError('spot_execution_requires_agent_vault', 'spot execution for an API key exists only through an agent vault under a spot mandate (Agents); it is not offered here', 403);
    throw new UserError('spot_via_swap_screen', 'a spot order of the owner is a swap proposal approved with the passkey: prepare it in the Swap screen (not wired to commands in this version)', 422);
  }
  if (p.kind !== 'owner' && !caller.mandateId) throw new UserError('mandate_required', 'this key has no trading mandate: an order command cannot execute', 403);
  const catalog = await perpCatalog(ex, body.mode, command.asset, body.accountId);
  const r = interpret(body.text, await commandDefaults(), catalog, { now, principal: caller.principal, mandateId: p.kind === 'owner' ? null : caller.mandateId, mode: body.mode, idempotencyKey: idemKey }).resolution!;
  if (r.kind === 'ambiguous') throw Object.assign(new UserError('ambiguous_command', 'the command and the owner\'s defaults do not settle everything: answer the questions (or set the defaults) and send it again. Nothing was executed.', 409), { data: { questions: r.questions } });
  if (r.kind === 'unresolvable') throw new UserError(r.code, r.message, 422);
  if (r.kind !== 'order') throw new UserError('bad_request', 'the command did not resolve to an order', 400);
  const attached = r.attached.map((a) => ({ role: a.role, order: a.order, hash: a.hash, placed: false, note: 'a stop-loss / take-profit is placed only once the entry is filled, sized to what was filled: not placed by this endpoint in this version' }));
  if (body.dryRun) return { ...base, kind: 'order', order: r.order, hash: r.hash, attached, executed: false };
  const out = await ex.orders.submitCanonical(caller, r.order, idemKey, { origin: 'command', strictReduce: command.type === 'perp_close', ...(body.accountId ? { accountId: body.accountId } : {}) });
  return { ...base, kind: 'order', executed: true, ...out, canonical: r.order, hash: r.hash, attached };
}
