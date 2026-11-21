/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/dashboard/activity.ts
 * Module           : dashboard
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-19
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

// GET /api/v1/dashboard/activity, GET /api/v1/dashboard/activity.csv — ONE history of every operation of the wallet, newest
// first. The route COMPOSES reads that already exist and adds no figure of its own:
//   wallet     the answer of GET /api/v1/activity (asked in process, with the caller's own session): transfers, receipts,
//              swaps (THORChain included), CCTP bridges, GMX order transactions            → transfer, receive, swap, bridge, order
//   plans      the answer of GET /api/v1/plans                                             → plan
//   orders     the unified orders of every venue and mode (`execution.orders.list`)        → order
//   decisions  the risk engine's decisions (`execution.risk.decisions`): DENIALS only, previews left out → risk
//   audit      the audit hash chain (`audit_events`): agent.*, strategy.*, research.* → agent; mandate.* → mandate;
//              risk.*, halt.* → risk; apikey.*, webhook.* → key; everything else → security. The events that only repeat a
//              wallet row (transfer.*, swap.*, bridge.*, xswap.*, deposit.seen) are left out: the wallet row is the item.
//              So are the engine events of an order (deriv.paper.order|close|cancel|fill, deriv.live.order_*): the unified order is the item.
// BOUND: each source is read for its SOURCE_BOUND newest rows (plans: 50, the bound of its route), so a page costs five small
// reads whatever the age of the wallet; the timeline therefore reaches back SOURCE_BOUND rows per source and no further.
// Each source fails on its own: it is then named in `errors` and the others are answered.
// An item carries CODES and parameters — never an English sentence for the screen to print. `mode` says which money the
// item is about (`paper` rows are never mixed with live ones by this route: it computes no total at all).
// Cursor: opaque, the key (time, id) of the last item of the page; the order (time desc, id desc) is total, so walking the
// pages gives every item once.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { auditChainStatus } from '../monitor/health.ts';
import { OWNER_CALLER } from '../orders/index.ts';
import { csvCell, NO_CONTROL } from '../wallet-api/labels.ts';
import type { DashboardOpts } from './index.ts';

export const ACTIVITY_KINDS = ['transfer', 'receive', 'swap', 'bridge', 'plan', 'order', 'agent', 'mandate', 'risk', 'key', 'security'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_SOURCES = ['wallet', 'plans', 'orders', 'decisions', 'audit'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];
export const SOURCE_BOUND = 500, PLANS_BOUND = 50, CSV_BOUND = 2500;
export type ActivityMode = 'live' | 'paper' | 'research' | null;
export interface ActivityItem {
  id: string; kind: ActivityKind; source: ActivitySource; at: string; mode: ActivityMode; venue: string | null; network: string | null;
  principal: { kind: string; id: string } | null;
  /** what happened, as a code the screen translates (`wallet.send`, `order`, `plan`, `risk.denied`, or the audit event type) with its parameters */
  code: string; params: Record<string, string | number | boolean | null>;
  status: string | null; instrument: string | null; side: string | null;
  amount: { value: string; symbol: string | null } | null; received: { value: string; symbol: string | null } | null;
  ref: { type: 'proposal' | 'deposit' | 'order' | 'audit' | 'decision' | 'plan'; id: string }; txid: string | null; explorer: string | null;
  /** wallet items: the row exactly as GET /api/v1/activity answers it (the screen keeps its detailed view of it) */
  wallet?: Record<string, unknown>;
}
export interface ActivityError { source: ActivitySource; code: string; message: string }

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** only what is safe and useful to show of an audit event's data: short scalars */
function scalars(d: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(d ?? {})) { if (Object.keys(out).length >= 12) break;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v; else if (typeof v === 'string' && v.length <= 160) out[k] = v; }
  return out;
}
/** `owner`, `key:<id>`, `agent:<id>`, `api_key:<id>` … → a principal; anything else is the system itself */
export function principalOfActor(actor: string): { kind: string; id: string } {
  if (actor === 'owner') return { kind: 'owner', id: 'owner' };
  const k = actor.indexOf(':'), head = k > 0 ? actor.slice(0, k) : actor, id = k > 0 ? actor.slice(k + 1) : actor;
  return head === 'key' || head === 'api_key' ? { kind: 'api_key', id } : head === 'agent' ? { kind: 'agent', id } : { kind: 'system', id: actor };
}
/** audit event type → kind of the timeline; null: the event only repeats a wallet row */
export function kindOfAudit(type: string): ActivityKind | null {
  const head = type.split('.')[0]!;
  if (head === 'transfer' || head === 'swap' || head === 'bridge' || head === 'xswap' || head === 'deposit') return null;
  if (/^deriv\.paper\.(order|close|cancel|fill|filled)$/.test(type) || /^deriv\.live\.order_/.test(type)) return null;   // the unified order (and its transitions) is the item
  if (head === 'agent' || head === 'strategy' || head === 'research') return 'agent';
  if (head === 'mandate' || /^deriv\.live\.mandate_/.test(type)) return 'mandate';
  if (head === 'risk' || head === 'halt') return 'risk';
  if (head === 'apikey' || head === 'webhook') return 'key';
  return 'security';
}

// ---------------------------------------------------------------------------------------------------------------- cursor, filters
export interface Cursor { at: number; id: string }
export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify([c.at, c.id])).toString('base64url');
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  try { const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown; if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && Number.isFinite(v[0]) && typeof v[1] === 'string') return { at: v[0], id: v[1] }; } catch { /* below */ }
  throw new UserError('invalid_cursor', 'this cursor is not one a previous page of this list returned', 400);
}
/** newest first; the id settles two items of the same instant */
export const byNewest = (a: ActivityItem, b: ActivityItem): number => { const x = Date.parse(a.at), y = Date.parse(b.at); return x !== y ? y - x : a.id === b.id ? 0 : a.id > b.id ? -1 : 1; };
const afterCursor = (i: ActivityItem, c: Cursor): boolean => { const x = Date.parse(i.at); return x < c.at || (x === c.at && i.id < c.id); };
const When = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), { message: 'a date or a date-time (ISO 8601)' });
const Filters = z.object({
  kind: z.enum(ACTIVITY_KINDS).optional(), mode: z.enum(['live', 'paper', 'research']).optional(), venue: z.string().min(1).max(40).optional().describe('a venue id or a network id'),
  principal: z.enum(['owner', 'agent', 'api_key', 'system']).optional(), from: When.optional(), to: When.optional(),
  // NEXT (additive): one network, one asset. They are handed to the wallet source, which applies them in SQL before its bound,
  // so an asset's history is not limited to the newest SOURCE_BOUND rows of the whole wallet.
  network: z.string().min(1).max(20).regex(NO_CONTROL).optional().describe('a network id: items on that network'),
  asset: z.string().min(1).max(130).regex(NO_CONTROL).optional().describe('an asset id (`native` or a contract / mint address): wallet items of that asset — the other sources have no asset and are left out'),
});
export type ActivityFilters = z.infer<typeof Filters>;
export function matches(i: ActivityItem, f: ActivityFilters): boolean {
  if (f.kind && i.kind !== f.kind) return false;
  if (f.mode && i.mode !== f.mode) return false;
  if (f.venue && i.venue !== f.venue && i.network !== f.venue) return false;
  if (f.principal && i.principal?.kind !== f.principal) return false;
  if (f.network && i.network !== f.network) return false;
  if (f.asset && !(i.source === 'wallet' && typeof i.wallet?.asset === 'string' && i.wallet.asset.toLowerCase() === f.asset.toLowerCase())) return false;
  const at = Date.parse(i.at);
  return !(f.from && at < Date.parse(f.from)) && !(f.to && at > Date.parse(f.to));
}

// ---------------------------------------------------------------------------------------------------------------- sources
type W = Record<string, any>;
const WALLET_KIND: Record<string, ActivityKind> = { send: 'transfer', receive: 'receive', swap: 'swap', bridge: 'bridge', gmx: 'order' };
export function walletItem(w: W): ActivityItem {
  const kind = WALLET_KIND[w.kind as string] ?? 'transfer', receive = w.kind === 'receive';
  const got = w.swap ? { value: String(w.swap.receivedDisplay ?? w.swap.minOutDisplay ?? ''), symbol: str(w.swap.toSymbol) } : null;
  return { id: `w:${w.id}`, kind, source: 'wallet', at: iso(w.at), mode: 'live', venue: w.kind === 'gmx' ? 'gmx' : null, network: str(w.network), principal: { kind: 'owner', id: 'owner' },
    code: `wallet.${w.kind}`, params: { ...(receive && typeof w.depositKind === 'string' ? { depositKind: w.depositKind } : {}), symbol: w.symbol ?? null, toSymbol: w.swap?.toSymbol ?? null, toNetwork: w.bridge?.toNetwork ?? null, received: w.swap ? w.swap.receivedDisplay !== null && w.swap.receivedDisplay !== undefined : null },
    status: str(w.state), instrument: str(w.symbol), side: null, amount: w.amountDisplay !== undefined ? { value: String(w.amountDisplay), symbol: str(w.symbol) } : null, received: got && got.value !== '' ? got : null,
    ref: { type: receive ? 'deposit' : 'proposal', id: String(w.id) }, txid: str(w.txid), explorer: str(w.explorer), wallet: w };
}
export function planItem(p: W): ActivityItem {
  return { id: `p:${p.id}`, kind: 'plan', source: 'plans', at: iso(p.createdAt), mode: 'live', venue: null, network: str(p.from?.network), principal: { kind: 'owner', id: 'owner' },
    code: 'plan', params: { from: p.from?.symbol ?? null, to: p.to?.symbol ?? null, toNetwork: p.to?.network ?? null, steps: typeof p.steps === 'number' ? p.steps : null, current: typeof p.current === 'number' ? p.current : null },
    status: str(p.state), instrument: null, side: null, amount: p.amountInDisplay !== undefined ? { value: String(p.amountInDisplay), symbol: str(p.from?.symbol) } : null, received: null, ref: { type: 'plan', id: String(p.id) }, txid: null, explorer: null };
}
export function orderItem(o: W): ActivityItem {
  return { id: `o:${o.orderId ?? o.id}`, kind: 'order', source: 'orders', at: iso(o.createdAt), mode: o.mode === 'paper' ? 'paper' : 'live', venue: str(o.venue), network: str(o.network), principal: o.principal ?? null,
    code: 'order', params: { type: o.type ?? null, engineStatus: o.engineStatus ?? null, reasonCode: o.reasonCode ?? null, rejectCode: o.rejectCode ?? null, origin: o.origin ?? null, mandateId: o.mandateId ?? null, reduceOnly: o.reduceOnly ?? null,
      price: o.price ?? null, triggerPrice: o.triggerPrice ?? null, filled: o.filled ?? null, avgFillPrice: o.avgFillPrice ?? null, notionalUsd: o.notionalUsd ?? null, final: o.final ?? null, updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : null },
    status: str(o.status), instrument: str(o.instrument), side: str(o.side), amount: o.size !== null && o.size !== undefined ? { value: String(o.size), symbol: typeof o.instrument === 'string' ? o.instrument.split(':').pop()!.replace(/-.*$/, '') : null } : null, received: null,
    ref: { type: 'order', id: String(o.id) }, txid: null, explorer: null };
}
export function decisionItem(d: W): ActivityItem {
  return { id: `d:${String(d.id).padStart(12, '0')}`, kind: 'risk', source: 'decisions', at: iso(d.at), mode: d.mode === 'paper' ? 'paper' : d.mode === 'research' ? 'research' : 'live', venue: str(d.venue), network: null, principal: d.principal ?? null,
    code: 'risk.denied', params: { failed: (d.failed as string[] ?? []).join(','), decisionKind: d.kind ?? null, reducing: !!d.reducing, orderId: d.orderId ?? null },
    status: 'denied', instrument: str(d.instrument), side: null, amount: null, received: null, ref: { type: 'decision', id: String(d.id) }, txid: null, explorer: null };
}
export function auditItem(e: { seq: number; ts: string; type: string; actor: string; data: Record<string, unknown> }): ActivityItem | null {
  const kind = kindOfAudit(e.type);
  if (!kind) return null;
  const d = e.data ?? {}, mode = d.mode === 'paper' || d.mode === 'live' || d.mode === 'research' ? d.mode : e.type.startsWith('deriv.paper.') ? 'paper' : null;
  return { id: `a:${String(e.seq).padStart(12, '0')}`, kind, source: 'audit', at: iso(e.ts), mode, venue: str(d.venue), network: str(d.network), principal: principalOfActor(e.actor), code: e.type, params: scalars(d),
    status: null, instrument: str(d.instrument), side: null, amount: null, received: null, ref: { type: 'audit', id: String(e.seq) }, txid: null, explorer: null };
}

const esc = csvCell;
/** Only ever appended to. NEXT appended the last six: they are filled for wallet items (the row of GET /api/v1/activity) and empty for the others. */
export const CSV_HEADER = 'time_utc,kind,mode,venue,network,principal,code,instrument_or_asset,side,amount,amount_symbol,received,received_symbol,status,reference_type,reference_id,txid,explorer'
  + ',lifecycle,fee_paid,fee_symbol,deposit_kind,deposit_origin,contact_label';
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** the NEXT columns of a wallet item: its life cycle (a receipt is confirming or confirmed), the fee really charged, what a receipt is, the contact */
function walletCells(w: Record<string, unknown> | undefined): string[] {
  if (!w) return ['', '', '', '', '', ''];
  const receive = w.kind === 'receive', paid = text(w.feePaidDisplay);
  return [receive ? (w.state === 'finalized' ? 'confirmed' : 'confirming') : text(w.lifecycle), paid, paid ? text(w.feeSymbol) : '', receive ? text(w.depositKind) : '', receive ? text(w.origin) : '', text(w.contactLabel)];
}
export const csvRow = (i: ActivityItem): string => [i.at, i.kind, i.mode ?? '', i.venue ?? '', i.network ?? '', i.principal ? (i.principal.kind === 'owner' ? 'owner' : `${i.principal.kind}:${i.principal.id}`) : '', i.code, i.instrument ?? '', i.side ?? '',
  i.amount?.value ?? '', i.amount?.symbol ?? '', i.received?.value ?? '', i.received?.symbol ?? '', i.status ?? '', i.ref.type, i.ref.id, i.txid ?? '', i.explorer ?? '', ...walletCells(i.wallet)].map(esc).join(',');

export function registerDashboardActivity(app: FastifyInstance, { execution }: DashboardOpts): void {
  const ownerOnly = (req: FastifyRequest): void => { if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route is for the owner\'s session', 403); };
  /** an existing route of this server, asked in process with the caller's own session (its answer is the source: no second copy of its logic) */
  const ask = async (req: FastifyRequest, url: string): Promise<W> => {
    const r = await app.inject({ method: 'GET', url, headers: { cookie: req.headers.cookie ?? '' } });
    if (r.statusCode !== 200) { const j = (() => { try { return r.json() as W; } catch { return {}; } })(); throw new UserError(typeof j.error === 'string' ? j.error : 'source_failed', String(j.message ?? `status ${r.statusCode}`), 502); }
    return r.json() as W;
  };
  async function collect(req: FastifyRequest, f: ActivityFilters = {}): Promise<{ items: ActivityItem[]; errors: ActivityError[] }> {
    const only = `${f.network ? `&network=${encodeURIComponent(f.network)}` : ''}${f.asset ? `&asset=${encodeURIComponent(f.asset)}` : ''}`;
    const errors: ActivityError[] = [];
    const src = async (source: ActivitySource, fn: () => Promise<ActivityItem[]>): Promise<ActivityItem[]> => {
      try { return await fn(); } catch (e) { const x = e as { code?: unknown; message?: unknown };
        errors.push({ source, code: typeof x?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(x.code) ? x.code : 'source_failed', message: String(x?.message ?? e).slice(0, 200) }); return []; }
    };
    const parts = await Promise.all([
      src('wallet', async () => ((await ask(req, `/api/v1/activity?limit=${SOURCE_BOUND}${only}`)).items as W[]).map(walletItem)),
      src('plans', async () => ((await ask(req, `/api/v1/plans?limit=${PLANS_BOUND}`)).plans as W[]).map(planItem)),
      src('orders', async () => (await execution.orders.list(OWNER_CALLER, { limit: SOURCE_BOUND })).map(orderItem)),
      src('decisions', async () => (await execution.risk.decisions(SOURCE_BOUND)).filter((d) => d.decision === 'deny' && !d.preview).map(decisionItem)),
      src('audit', async () => (await sql<{ seq: number; ts: string; type: string; actor: string; data: Record<string, unknown> }[]>`select seq::int as seq, ts, type, actor, data from audit_events order by seq desc limit ${SOURCE_BOUND}`)
        .map(auditItem).filter((x): x is ActivityItem => x !== null)),
    ]);
    return { items: parts.flat().sort(byNewest), errors };
  }
  const chain = async () => { try { const s = await auditChainStatus(Date.now()); return { intact: s.intact, brokenAt: s.brokenAt, total: s.total, checkedAt: s.checkedAt }; } catch { return null; } };

  app.get('/api/v1/dashboard/activity', async (req) => {
    ownerOnly(req);
    const q = Filters.extend({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(400).regex(/^[A-Za-z0-9_-]+$/).optional() }).parse(req.query ?? {});
    const cur = decodeCursor(q.cursor);
    const [{ items, errors }, audit] = await Promise.all([collect(req, q), chain()]);
    const rest = items.filter((i) => matches(i, q) && (!cur || afterCursor(i, cur))), page = rest.slice(0, q.limit), last = page.at(-1);
    return { items: page, nextCursor: rest.length > q.limit && last ? encodeCursor({ at: Date.parse(last.at), id: last.id }) : null, errors, audit,
      bounds: { perSource: SOURCE_BOUND, plans: PLANS_BOUND }, kinds: ACTIVITY_KINDS, ts: Date.now() };
  });

  app.get('/api/v1/dashboard/activity.csv', async (req, reply) => {
    ownerOnly(req);
    const q = Filters.parse(req.query ?? {});
    const { items } = await collect(req, q);
    const lines = [CSV_HEADER, ...items.filter((i) => matches(i, q)).slice(0, CSV_BOUND).map(csvRow)];
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="sp-wallet-activity.csv"').send(lines.join('\n') + '\n');
  });
}
