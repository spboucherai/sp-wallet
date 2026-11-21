/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mandates/service.ts
 * Module           : mandates
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// Trading mandates (V11): the owner's written permission for ONE principal — an agent or an API key — to trade, inside limits,
// until a date. The canonical object is `SPW-TRADING-MANDATE-v1` of @spw/trading; this service stores it, has it approved, and
// answers "does this order fit" with the usage it measures itself.
//
// Rules this file enforces
//  - A mandate is immutable. There is no update: a change is a new mandate; the old one is revoked.
//  - Only the owner's session creates, approves or revokes. No route of this module is under /api/v1/trading, so no API key
//    reaches it; a key cannot create, alter, approve or revoke anything about a mandate — its own included.
//  - PAPER: no signer and no passkey; the same schema and the same checks.
//  - LIVE: the mandate must compile (`compileTradingMandate`) into a shape the isolated signer enforces, and is approved at the
//    signer through the EXISTING derivative-mandate flow of the Hyperliquid engine (exec.ts prepareCompiledMandate →
//    approveMandate): one passkey ceremony, whose challenge is the hash of the compiled derivative mandate. A venue with no
//    signer-side mandate (GMX, anything else) is refused at creation: API-only enforcement is not accepted for live autonomous
//    trading. dYdX and edgeX are refused for the jurisdiction, in any mode.
//  - An API key has no strategy: the signer mandate's `strategySha256` then carries SHA-256 of the canonical principal descriptor
//    `spw-principal-v1|api_key|<key id>` (the signer records that field and never interpreted it).
//  - Revocation revokes at the signer too. A stop condition engages a wind-down: the mandate is revoked with the reason
//    `stop_condition`, its resting orders are cancelled, and only strictly reducing orders pass for the wind-down period.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { D, type DecStr } from '@spw/derivatives';
import { hex, type VenueMandate } from '@spw/derivatives/live';
import {
  checkTradingMandateOrder, compileToVenueMandate, revokeTradingMandate, SIGNER_MANDATE_SHAPES, StopConditionSchema, TRADING_MANDATE_WIND_DOWN_S, TradingMandateError, tradingMandateHashHex, tradingMandatePhase, TradingMandateSchema,
  validateTradingMandate, type CanonicalOrder, type FieldEnforcement, type MandateAccount, type MandateDecision, type TradingMandate, type TradingMandatePhase, type TradingMandateUsage,
} from '@spw/trading';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import type { Derivatives } from '../derivatives/index.ts';
import { canonicalIntentHash, type LiveService } from '../derivatives/exec.ts';
import { DYDX_RESTRICTION, EDGEX_RESTRICTION } from '../derivatives/venues.ts';
import { prepareIntent, takeIntent, type PasskeyDeps, type Stamped } from '../risk/passkey.ts';
import type { Evaluated } from '../risk/service.ts';
import { webauthnOptions } from '../risk/passkey.ts';
import { venueQuotingMandateHash, type VenueQuotingMandate } from '@spw/derivatives/live';
import { buildQuotingSection, compileQuoting, QuotingCreateSchema, QUOTING_SHAPE, quotingAgent, quotingNetworkLock, sectionHash, type QuotingSignerPort, type StoredQuoting } from '../mm/quoting-mandate.ts';
import type { MmLocks } from '../mm/live-adapter.ts';

/** the convention of an API-key principal in the signer's `strategySha256` field */
export const principalDescriptor = (p: { kind: 'api_key' | 'agent'; id: string }): string => `spw-principal-v1|${p.kind}|${p.id}`;
export const principalDescriptorSha256 = (p: { kind: 'api_key' | 'agent'; id: string }): string => createHash('sha256').update(principalDescriptor(p)).digest('hex');

const PosDec = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/);
export const MandateCreateSchema = z.strictObject({
  principal: z.strictObject({ kind: z.enum(['agent', 'api_key']), id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/) }),
  mode: z.enum(['paper', 'live']),
  /** ids of the wallet's own accounts: paper accounts (paper mode) or venue accounts (live mode) */
  accountIds: z.array(z.uuid()).min(1).max(8),
  /** default: the venues of the accounts */
  venues: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).min(1).max(8).optional(),
  instruments: TradingMandateSchema.shape.instruments, marketKinds: TradingMandateSchema.shape.marketKinds.default(['perp']), orderTypes: TradingMandateSchema.shape.orderTypes,
  maxCapitalUsd: PosDec, maxOrderNotionalUsd: PosDec, maxPositionNotionalUsd: PosDec, maxLeverage: PosDec, maxDailyLossUsd: PosDec, floorEquityUsd: PosDec,
  days: z.number().int().min(1).max(365), frequency: TradingMandateSchema.shape.frequency, maxSlippageBps: TradingMandateSchema.shape.maxSlippageBps, maxFeeUsd: PosDec,
  stopConditions: z.array(StopConditionSchema).max(10).default([]),
  /** agents only: the strategy version the mandate is approved for */
  strategySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  label: z.string().trim().min(1).max(60), locale: z.enum(['fr', 'en']).default('en'),
  /** V11 market making: present = a QUOTING mandate (live, for a market-making agent). The quote rates, the quote geometry and the
   *  session settings live here — a sibling record of the trading mandate, covered by the same passkey-bound approval. */
  quoting: QuotingCreateSchema.optional(),
});
export type MandateCreate = z.infer<typeof MandateCreateSchema>;

export type MandateState = 'created' | 'pending_signer' | 'active' | 'revoked' | 'failed';
/**
 * What the owner's passkey commits to at the approval of a LIVE mandate, on the API side: the FULL trading mandate hash — every
 * field, the API-only ones included — and the hash of the derivative mandate compiled from it. The challenge of the assertion is
 * the hash of this intent (domain below). The intent and the assertion are stored with the mandate and verified again every time
 * the row is loaded for enforcement (`integrity`).
 */
export const MANDATE_APPROVAL_DOMAIN = 'SPW-TRADING-MANDATE-APPROVAL-v1';
export interface MandateApprovalIntent { [k: string]: unknown; v: 1; kind: 'trading_mandate_approval'; mandateId: string; tradingMandateHash: string; principal: string; mode: 'live'; signer: { shape: string; mandateHash: string };
  /** quoting mandates only: the hash of the sibling record SPW-QUOTING-SECTION-v1 (quote rates, geometry, session settings) */ quotingSectionHash?: string }
export interface MandateApproval { v: 1; domain: typeof MANDATE_APPROVAL_DOMAIN; intent: Stamped<MandateApprovalIntent>; hash: string; assertion: unknown; credentialId: string | null; approvedAt: number }
const approvalKey = (id: string): string => `mandate.intent.approve.${id}`;
interface Row {
  id: string; principal_kind: 'agent' | 'api_key'; principal_id: string; mode: 'paper' | 'live'; mandate: TradingMandate; hash: string; state: MandateState; enforcement: FieldEnforcement[];
  compiled: { accounts: { accountId: string; account: MandateAccount }[]; venue?: { accountId: string; mandate: VenueMandate | VenueQuotingMandate; hash?: string; derived: { field: string; value: string; from: string }[] } } | null;
  /** V11 market making: non-null = a quoting mandate */ quoting: StoredQuoting | null;
  signer: { shape: string; accountId: string; mandateId: string; hash: string } | null; approval: MandateApproval | null; revocation: Record<string, unknown> | null; stop: { code: string; at: number; detail: string } | null;
  created_at: Date; approved_at: Date | null; revoked_at: Date | null; updated_at: Date;
}
interface UsageRow { mandate_id: string; orders_accepted: number; orders_rejected: number; consecutive_rejects: number; notional_total: string; peak_equity: string | null; start_equity: string | null; last_order_at: Date | null; signer_unreachable_since: Date | null }

export interface MandateDeps {
  now: () => number; derivatives: () => Derivatives; live: () => LiveService;
  /** throws when the signer cannot be reached (supervisor: signer_unreachable_gte) */
  signerStatus: () => Promise<{ halted: boolean }>;
  /** wind-down: cancel what rests under a mandate (the order service); returns how many cancels were requested */
  cancelResting?: (mandateId: string) => Promise<number>;
  /** the API's own passkey step (risk/passkey.ts): the approval of a live mandate commits to the full trading mandate hash */
  passkey?: PasskeyDeps;
  /** verifies again an assertion stored at approval (signature of an enrolled passkey over the challenge; no counter) */
  reverify?: (assertion: unknown, challenge: Uint8Array) => Promise<void>;
  /** V11 market making: the signer's quoting endpoints; absent = quoting mandates are unavailable (503 quoting_unavailable) */
  quotingSigner?: QuotingSignerPort;
  /** the server locks of quoting, read at every use (default: the process environment) */
  mmLocks?: () => MmLocks;
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
/** venues the wallet never trades, for the owner's jurisdiction (docs/v4/venues/jurisdiction.md) */
const JURISDICTION: Readonly<Record<string, string>> = { dydx: DYDX_RESTRICTION, edgex: EDGEX_RESTRICTION };
const PAPER_ENFORCEMENT_NOTE = 'paper: nothing is signed; every field is enforced by the API on the simulated account';

export class MandateService {
  readonly deps: MandateDeps;
  readonly now: () => number;
  private readonly quotingEquity = new Map<string, { at: number; equity: DecStr | null }>();
  constructor(deps: MandateDeps) { this.deps = deps; this.now = deps.now; }

  // ------------------------------------------------------------------ storage and views
  private async row(id: string): Promise<Row> {
    const [r] = /^[0-9a-f-]{36}$/.test(id) ? await sql<Row[]>`select * from trading_mandates where id = ${id}` : [];
    if (!r) throw new UserError('unknown_mandate', 'unknown trading mandate', 404);
    return r;
  }
  private async usageRow(id: string): Promise<UsageRow> {
    const [u] = await sql<UsageRow[]>`insert into trading_mandate_usage (mandate_id) values (${id}) on conflict (mandate_id) do update set mandate_id = excluded.mandate_id returning *`;
    return u!;
  }
  phase(r: Pick<Row, 'mandate' | 'state' | 'revoked_at'>): TradingMandatePhase | 'not_approved' {
    if (r.state !== 'active' && r.state !== 'revoked') return 'not_approved';
    return tradingMandatePhase(r.mandate, r.revoked_at ? Math.floor(r.revoked_at.getTime() / 1000) : null, Math.floor(this.now() / 1000));
  }
  private async view(r: Row) {
    const u = await this.usageRow(r.id), now = this.now();
    const [c] = await sql<{ minute: number; hour: number; today: number; open: number }[]>`select count(*) filter (where created_at > ${new Date(now - 60_000)})::int as minute, count(*) filter (where created_at > ${new Date(now - 3_600_000)})::int as hour,
      count(*) filter (where created_at >= ${new Date(dayStart(now))})::int as today, count(*) filter (where state not in ('FILLED', 'CANCELLED', 'REJECTED', 'FAILED'))::int as open
      from orders where mandate_id = ${r.id} and not reduce_only and state not in ('REJECTED', 'FAILED')`;
    return {
      id: r.id, kind: r.quoting ? 'quoting' as const : 'directional' as const, quoting: r.quoting ? { section: r.quoting.section, hash: r.quoting.hash, termsEnforcement: r.quoting.termsEnforcement, sectionEnforcement: r.quoting.sectionEnforcement, maxima: r.quoting.maxima, agent: r.quoting.agent } : null,
      principal: { kind: r.principal_kind, id: r.principal_id }, mode: r.mode, state: r.state, phase: this.phase(r), hash: r.hash, mandate: r.mandate, label: r.mandate.label,
      /** field by field: enforced by the isolated signer, partly, or by the API only (a compromised API could ignore an API-only field) */
      enforcement: r.enforcement, derived: r.compiled?.venue?.derived ?? [], signer: r.signer, stop: r.stop, revocation: r.revocation,
      /** live: the passkey approval of the FULL mandate hash, as stored (never the assertion itself), and whether the row still verifies against it */
      approval: r.approval ? { domain: r.approval.domain, hash: r.approval.hash, tradingMandateHash: r.approval.intent.tradingMandateHash, signerMandateHash: r.approval.intent.signer.mandateHash, quotingSectionHash: r.approval.intent.quotingSectionHash ?? null, credentialId: r.approval.credentialId, approvedAt: r.approval.approvedAt } : null,
      integrity: r.state === 'active' || r.state === 'revoked' ? await this.integrity(r).then((reason) => ({ ok: reason === null, reason })) : null,
      usage: { ordersAccepted: u.orders_accepted, ordersRejected: u.orders_rejected, consecutiveRejects: u.consecutive_rejects, notionalTotal: D.str(D.from(u.notional_total)), peakEquity: u.peak_equity, startEquity: u.start_equity,
        lastOrderAt: u.last_order_at?.getTime() ?? null, ordersLastMinute: c!.minute, ordersLastHour: c!.hour, ordersToday: c!.today, openOrders: c!.open },
      createdAt: r.created_at.getTime(), approvedAt: r.approved_at?.getTime() ?? null, revokedAt: r.revoked_at?.getTime() ?? null, notBefore: r.mandate.notBefore * 1000, notAfter: r.mandate.notAfter * 1000,
    };
  }
  /**
   * Is the stored row still the mandate the owner approved? null = yes; otherwise the reason, and the mandate is unusable.
   * Every mode: the stored object hashes to the recorded hash, and the columns the service filters on say what the hashed object says.
   * LIVE: in addition the stored passkey assertion verifies again over the stored approval intent, and that intent names this
   * mandate's FULL hash and the derivative mandate the signer holds. See docs/TRADING-MANDATES.md ("What the passkey signs").
   */
  async integrity(r: Row): Promise<string | null> {
    let hash: string;
    try { hash = tradingMandateHashHex(r.mandate); } catch (e) { return `the stored mandate is not a valid trading mandate (${msg(e)})`; }
    if (hash !== r.hash) return 'the stored mandate does not hash to its recorded hash';
    if (r.mandate.mandateId !== r.id || r.mandate.principal.kind !== r.principal_kind || r.mandate.principal.id !== r.principal_id || r.mandate.mode !== r.mode) return 'the row names another id, principal or mode than the mandate it stores';
    const named = new Set(r.mandate.accounts.map((a) => JSON.stringify(a, Object.keys(a).sort())));
    for (const a of r.compiled?.accounts ?? []) if (!named.has(JSON.stringify(a.account, Object.keys(a.account).sort()))) return 'the row maps the mandate to an account the mandate does not name';
    if (r.quoting) {
      let qh: string;
      try { qh = sectionHash(r.quoting.section); } catch (e) { return `the stored quoting section is not valid (${msg(e)})`; }
      if (qh !== r.quoting.hash) return 'the stored quoting section does not hash to its recorded hash';
      if (r.quoting.section.mandateId !== r.id || r.quoting.section.tradingMandateHash !== r.hash) return 'the stored quoting section belongs to another mandate';
      if (r.mode !== 'live' || r.principal_kind !== 'agent') return 'a quoting mandate is a live mandate of an agent';
    }
    if (r.mode !== 'live') return null;
    const a = r.approval;
    if (!a || a.domain !== MANDATE_APPROVAL_DOMAIN) return 'no passkey approval of the full mandate hash is stored with this live mandate';
    if (a.intent.kind !== 'trading_mandate_approval' || a.intent.mandateId !== r.id || a.intent.tradingMandateHash !== r.hash) return 'the stored passkey approval is for another mandate or another hash';
    if (!r.signer || a.intent.signer.mandateHash !== r.signer.hash || a.intent.signer.shape !== r.signer.shape) return 'the stored passkey approval names another signer mandate than the one recorded';
    if ((r.quoting?.hash ?? undefined) !== a.intent.quotingSectionHash) return 'the stored passkey approval does not name this mandate\'s quoting section';
    if ((r.signer.shape === QUOTING_SHAPE) !== (r.quoting !== null && r.quoting !== undefined)) return 'the signer shape recorded does not match the kind of the mandate';
    if (hex(canonicalIntentHash(MANDATE_APPROVAL_DOMAIN, a.intent)) !== a.hash) return 'the stored approval intent is not intact';
    if (!this.deps.reverify) return 'this server cannot verify a stored passkey approval';
    try { await this.deps.reverify(a.assertion, Buffer.from(a.hash, 'hex')); } catch (e) { return `the stored passkey approval does not verify (${msg(e)})`; }
    return null;
  }
  /** the first holder of a LIVE venue account other than `except`: a trading mandate (approved or at the signer) or a perp agent's derivative mandate */
  async accountHolder(accountId: string, except: { mandateId: string | null; principal: { kind: string; id: string } }): Promise<{ via: 'trading_mandate' | 'derivative_mandate'; mandateId: string; principal: string } | null> {
    const nowSec = Math.floor(this.now() / 1000);
    for (const o of await sql<Row[]>`select * from trading_mandates where mode = 'live' and state in ('active', 'pending_signer') and id::text <> ${except.mandateId ?? ''}`) {
      if (!(o.compiled?.accounts ?? []).some((a) => a.accountId === accountId) || o.mandate.notAfter <= nowSec) continue;
      if (o.principal_kind === except.principal.kind && o.principal_id === except.principal.id && o.state !== 'active') continue;   // the same principal preparing again
      return { via: 'trading_mandate', mandateId: o.id, principal: `${o.principal_kind}:${o.principal_id}` };
    }
    const [dm] = await sql<{ id: string; mandate: VenueMandate }[]>`select id, mandate from deriv_mandates where account_id::text = ${accountId} and state = 'active' and id::text <> ${except.mandateId ?? ''} order by approved_at desc limit 1`;
    if (dm && dm.mandate.expiresAt > nowSec) return { via: 'derivative_mandate', mandateId: dm.id, principal: `agent:${dm.mandate.agentId}` };
    return null;
  }
  /**
   * V11 market making — a venue account carries ONE standing authority: a directional mandate or a quoting mandate, never both
   * (the signer refuses the second with `conflict`). Said here first, with a code that names the direction of the conflict.
   */
  private async refuseOtherKind(accountId: string, mandateId: string | null, quoting: boolean): Promise<void> {
    const nowSec = Math.floor(this.now() / 1000);
    if (quoting) {
      const [dm] = await sql<{ id: string; mandate: VenueMandate }[]>`select id, mandate from deriv_mandates where account_id::text = ${accountId} and state = 'active' and id::text <> ${mandateId ?? ''} order by approved_at desc limit 1`;
      if (dm && dm.mandate.expiresAt > nowSec) throw Object.assign(new UserError('quoting_excludes_directional', `this venue account carries the active directional mandate ${dm.id}: a quoting mandate and a directional mandate exclude each other on a venue account (the signer refuses the second). Revoke the directional mandate first.`, 409), { data: { holder: { via: 'derivative_mandate', mandateId: dm.id } } });
      return;
    }
    for (const o of await sql<Row[]>`select * from trading_mandates where mode = 'live' and state = 'active' and quoting is not null and id::text <> ${mandateId ?? ''}`) {
      if (!(o.compiled?.accounts ?? []).some((a) => a.accountId === accountId) || this.phase(o) !== 'active') continue;
      throw Object.assign(new UserError('directional_excludes_quoting', `this venue account carries the active quoting mandate ${o.id} (market making): a directional mandate and a quoting mandate exclude each other on a venue account (the signer refuses the second). Revoke the quoting mandate first.`, 409), { data: { holder: { via: 'quoting_mandate', mandateId: o.id } } });
    }
  }
  private quotingSigner(): QuotingSignerPort {
    if (!this.deps.quotingSigner) throw new UserError('quoting_unavailable', 'quoting mandates are not available on this server (no signer port)', 503);
    return this.deps.quotingSigner;
  }
  /** the last approved quoting mandate of a market-making agent with its phase and integrity, or null. The one a live session runs under. */
  async quotingFor(agentId: string): Promise<{ row: Row; phase: TradingMandatePhase | 'not_approved'; integrity: string | null } | null> {
    const [r] = await sql<Row[]>`select * from trading_mandates where principal_kind = 'agent' and principal_id = ${agentId} and mode = 'live' and quoting is not null and state in ('active', 'revoked') order by approved_at desc nulls last limit 1`;
    if (!r) return null;
    return { row: r, phase: this.phase(r), integrity: await this.integrity(r) };
  }
  private async refuseSecondPrincipal(accountId: string, mandateId: string | null, principal: { kind: string; id: string }): Promise<void> {
    const h = await this.accountHolder(accountId, { mandateId, principal });
    if (h) throw Object.assign(new UserError('account_has_active_mandate', `this venue account already carries the mandate ${h.mandateId} of ${h.principal}: one venue account serves one principal at a time (the signer holds one derivative mandate per account, and positions on a venue are not separable by principal). Revoke that mandate first, or use another venue account.`, 409), { data: { holder: h } });
  }
  async get(id: string) { return this.view(await this.row(id)); }
  async list() { const rows = await sql<Row[]>`select * from trading_mandates order by created_at desc limit 200`; return Promise.all(rows.map((r) => this.view(r))); }

  // ------------------------------------------------------------------ creation
  private async resolveAccounts(mode: 'paper' | 'live', ids: string[]): Promise<{ accountId: string; account: MandateAccount }[]> {
    const out: { accountId: string; account: MandateAccount }[] = [];
    for (const id of [...new Set(ids)]) {
      if (mode === 'paper') {
        const [a] = await sql<{ id: string; venue: string; network: string }[]>`select id, venue, network from deriv_paper_accounts where id = ${id}`;
        if (!a) throw new UserError('unknown_account', `no paper account ${id}`, 404);
        out.push({ accountId: a.id, account: { kind: 'venue_account', venue: a.venue, network: a.network, account: a.id } });
      } else {
        const [a] = await sql<{ id: string; venue: string; network: string; account: string }[]>`select id, venue, network, account from deriv_accounts where id = ${id}`;
        if (!a) throw new UserError('unknown_account', `no venue account ${id}`, 404);
        out.push({ accountId: a.id, account: { kind: 'venue_account', venue: a.venue, network: a.network, account: a.account.toLowerCase() } });
      }
    }
    return out;
  }
  private refuseVenues(mode: 'paper' | 'live', venues: string[]): void {
    const reg = this.deps.derivatives().registry;
    for (const v of venues) {
      const entry = reg.list().find((e) => e.id === v);
      // jurisdiction first, in any mode: dYdX and edgeX are market data only for this wallet (also when this server's registry does not list them)
      const restriction = entry ? entry.restriction : Object.hasOwn(JURISDICTION, v) ? JURISDICTION[v]! : null;
      if (restriction !== null) throw new UserError('venue_restricted', `${entry?.name ?? v} is never tradable from this wallet: ${restriction}`, 403);
      if (mode === 'live') {
        if (!Object.hasOwn(SIGNER_MANDATE_SHAPES, v)) throw new UserError('no_signer_mandate_for_venue', `the isolated signer has no mandate for the venue ${v}: a live mandate there would be enforced by the API only, which is not accepted. Orders on ${v} need the owner's passkey each.`, 422);
        if (v !== 'hyperliquid') throw new UserError('spot_mandate_via_agent_vault', `a live spot mandate on ${v} is approved through an agent vault (Agents screen); it is not created here`, 422);
      } else if (!entry) throw new UserError('unknown_venue', `unknown venue ${v}`, 404);
    }
  }

  /** the owner's session only. Nothing is approved here: the mandate is stored `created` and has no effect until approved. */
  async create(raw: unknown) {
    const b = MandateCreateSchema.parse(raw), nowSec = Math.floor(this.now() / 1000);
    // a quoting mandate is a LIVE mandate of an AGENT: said before anything else is looked up
    if (b.quoting && b.principal.kind !== 'agent') throw new UserError('quoting_requires_agent', 'a quoting mandate is approved for a market-making AGENT, never for an API key', 422);
    if (b.quoting && b.mode !== 'live') throw new UserError('quoting_requires_live', 'a quoting mandate is a live mandate: paper market making needs no mandate of this kind', 422);
    if (b.principal.kind === 'api_key') {
      const [k] = await sql`select id from api_keys where id = ${b.principal.id} and revoked_at is null`;
      if (!k) throw new UserError('unknown_principal', 'no active API key with this id', 404);
    } else {
      const [a] = /^[0-9a-f-]{36}$/.test(b.principal.id) ? await sql`select id from agents where id = ${b.principal.id}` : [];
      if (!a) throw new UserError('unknown_principal', 'no agent with this id', 404);
      if (!b.strategySha256) throw new UserError('strategy_hash_required', 'an agent mandate names the strategy version it is approved for', 400);
    }
    const venuesAsked = b.venues ?? [...new Set(b.instruments.map((i) => i.slice(0, i.indexOf(':'))))];
    this.refuseVenues(b.mode, venuesAsked);
    const accounts = await this.resolveAccounts(b.mode, b.accountIds);
    const venues = b.venues ?? [...new Set(accounts.map((a) => (a.account.kind === 'venue_account' ? a.account.venue : '')))].filter(Boolean);
    this.refuseVenues(b.mode, venues);
    const mandate: TradingMandate = {
      v: 1, mandateId: randomUUID(), principal: b.principal, accounts: accounts.map((a) => a.account), venues, networks: [...new Set(accounts.map((a) => a.account.network))], instruments: b.instruments, marketKinds: b.marketKinds, orderTypes: b.orderTypes,
      maxCapitalUsd: b.maxCapitalUsd, maxOrderNotionalUsd: b.maxOrderNotionalUsd, maxPositionNotionalUsd: b.maxPositionNotionalUsd, maxLeverage: b.maxLeverage, maxDailyLossUsd: b.maxDailyLossUsd, floorEquityUsd: b.floorEquityUsd,
      createdAt: nowSec, notBefore: nowSec, notAfter: nowSec + b.days * 86400, frequency: b.frequency, maxSlippageBps: b.maxSlippageBps, maxFeeUsd: b.maxFeeUsd, stopConditions: b.stopConditions, mode: b.mode,
      strategySha256: b.principal.kind === 'api_key' ? principalDescriptorSha256(b.principal) : b.strategySha256!, label: b.label,
    };
    try { validateTradingMandate(mandate, nowSec); } catch (e) { if (e instanceof TradingMandateError) throw new UserError(e.code, `${e.field ? `${e.field}: ` : ''}${e.message}`, 400); throw e; }
    let enforcement: FieldEnforcement[], compiled: Row['compiled'] = { accounts };
    let quoting: StoredQuoting | null = null;
    if (b.quoting) {
      // a QUOTING mandate: live, for a market-making agent, one instrument; every value inside a compiled bound or refused
      if (b.principal.kind !== 'agent') throw new UserError('quoting_requires_agent', 'a quoting mandate is approved for a market-making AGENT, never for an API key', 422);
      if (b.mode !== 'live') throw new UserError('quoting_requires_live', 'a quoting mandate is a live mandate: paper market making needs no mandate of this kind', 422);
      this.quotingSigner();
      const agent = await quotingAgent(b.principal.id), mh = tradingMandateHashHex(mandate);
      const section = buildQuotingSection(mandate, mh, b.quoting, agent);
      // exclusivity first: it is the more useful answer than a bound the other mandate would make moot
      for (const a of accounts) await this.refuseOtherKind(a.accountId, null, true);
      const c = await this.compileQuotingFor(mandate, section, accounts, b.locale);
      for (const a of accounts) await this.refuseSecondPrincipal(a.accountId, null, b.principal);
      enforcement = c.enforcement; compiled = { accounts, venue: { accountId: c.accountId, mandate: c.mandate, derived: c.derived } };
      quoting = { section, hash: sectionHash(section), termsEnforcement: c.termsEnforcement, sectionEnforcement: c.sectionEnforcement, maxima: c.maxima, agent: { id: agent.id, rule: agent.rule, configVersion: agent.configVersion, instrument: agent.instrument } };
    } else if (b.mode === 'live') {
      // a venue account under an active QUOTING mandate takes no directional mandate (said before anything else about this one)
      for (const a of accounts) await this.refuseOtherKind(a.accountId, null, false);
      // refused NOW if it cannot be compiled for the signer: a live mandate never exists in a form the signer does not bound
      const c = await this.compile(mandate, accounts, b.locale);
      // one venue account serves one principal at a time: a second principal is refused before anything is stored
      for (const a of accounts) await this.refuseSecondPrincipal(a.accountId, null, b.principal);
      enforcement = c.enforcement; compiled = { accounts, venue: { accountId: c.accountId, mandate: c.mandate, derived: c.derived } };
    } else enforcement = (Object.keys(TradingMandateSchema.shape) as (keyof TradingMandate)[]).map((field) => ({ field, enforcedBy: 'api_only' as const, signerField: null, note: PAPER_ENFORCEMENT_NOTE }));
    const hash = tradingMandateHashHex(mandate);
    await sql`insert into trading_mandates (id, principal_kind, principal_id, mode, mandate, hash, state, enforcement, compiled, quoting) values (${mandate.mandateId}, ${b.principal.kind}, ${b.principal.id}, ${b.mode}, ${sql.json(mandate as never)}, ${hash},
      'created', ${sql.json(enforcement as never)}, ${sql.json(compiled as never)}, ${quoting ? sql.json(quoting as never) : null})`;
    await audit('mandate.created', 'owner', { mandateId: mandate.mandateId, hash, kind: quoting ? 'quoting' : 'directional', ...(quoting ? { quotingSectionHash: quoting.hash } : {}), principal: `${b.principal.kind}:${b.principal.id}`, mode: b.mode, venues, instruments: b.instruments, maxCapitalUsd: b.maxCapitalUsd, maxOrderNotionalUsd: b.maxOrderNotionalUsd, notAfter: mandate.notAfter }).catch(() => {});
    return this.get(mandate.mandateId);
  }

  private async compile(mandate: TradingMandate, accounts: { accountId: string; account: MandateAccount }[], locale: 'fr' | 'en') {
    const hl = accounts.filter((a) => a.account.kind === 'venue_account' && a.account.venue === 'hyperliquid');
    if (hl.length !== 1) throw new UserError(hl.length ? 'ambiguous_account' : 'account_not_in_mandate', 'a live mandate covers exactly one Hyperliquid venue account', 422);
    const binding = await this.deps.live().mandateBinding(hl[0]!.accountId, locale);      // refuses with the precise lock code (mainnet_disabled, mandate_mainnet_disabled, mode_read_only, …)
    try {
      const c = compileToVenueMandate(mandate, { authorization: binding.authorization, ackSha256: binding.ack.sha256 });
      return { accountId: hl[0]!.accountId, mandate: c.mandate, enforcement: c.enforcement, derived: c.derived };
    } catch (e) {
      if (e instanceof TradingMandateError) throw new UserError(e.code, `${e.field ? `${e.field}: ` : ''}${e.message}`, 422);
      throw e;
    }
  }

  /** quoting: the binding of the venue account (the two mainnet locks of the live engine apply), the lock of quoting on that network, then the compilation */
  private async compileQuotingFor(mandate: TradingMandate, section: StoredQuoting['section'], accounts: { accountId: string; account: MandateAccount }[], locale: 'fr' | 'en') {
    const hl = accounts.filter((a) => a.account.kind === 'venue_account' && a.account.venue === 'hyperliquid');
    if (hl.length !== 1 || accounts.length !== 1) throw new UserError(hl.length ? 'ambiguous_account' : 'account_not_in_mandate', 'a quoting mandate covers exactly one Hyperliquid venue account', 422);
    const binding = await this.deps.live().mandateBinding(hl[0]!.accountId, locale);      // mainnet_disabled, mandate_mainnet_disabled, mode_read_only, …
    const lock = quotingNetworkLock(binding.network, this.deps.mmLocks?.());
    if (lock) throw lock;
    return { accountId: hl[0]!.accountId, binding, ...compileQuoting(mandate, section, { authorization: binding.authorization, ackSha256: binding.ack.sha256 }) };
  }

  // ------------------------------------------------------------------ approval
  /**
   * What the approval sheet shows before the passkey prompt: every field of the mandate, its hash, and the table that says, field
   * by field, what the signer enforces and what only the API enforces. Live: the WebAuthn request, whose challenge is the hash of
   * the compiled derivative mandate — the object the signer stores and enforces.
   */
  async prepareApproval(id: string, locale: 'fr' | 'en' = 'en') {
    const r = await this.row(id);
    if (r.state !== 'created' && r.state !== 'pending_signer') throw new UserError('bad_state', `the mandate is ${r.state}`, 409);
    const base = { mandateId: r.id, mandate: r.mandate, hash: r.hash, mode: r.mode, enforcement: r.enforcement, derived: r.compiled?.venue?.derived ?? [], principalDescriptor: r.principal_kind === 'api_key' ? principalDescriptor({ kind: 'api_key', id: r.principal_id }) : null };
    if (r.mode === 'paper') return { ...base, passkey: false as const, signer: null, note: 'a paper mandate needs no signer and no passkey: nothing is signed in paper mode' };
    if (tradingMandateHashHex(r.mandate) !== r.hash) throw new UserError('mandate_integrity', 'the stored mandate does not hash to its recorded hash: create it again', 409);
    for (const a of r.compiled!.accounts) { await this.refuseOtherKind(a.accountId, r.id, r.quoting !== null && r.quoting !== undefined); await this.refuseSecondPrincipal(a.accountId, r.id, { kind: r.principal_kind, id: r.principal_id }); }
    if (!this.deps.passkey?.verifyOwner) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval: a live mandate cannot be approved', 503);
    if (r.quoting) return this.prepareQuotingApproval(r, base, locale);
    // compiled again against the authorization as it is now: the stored compilation must still be exactly what the signer will be asked to approve
    const c = await this.compile(r.mandate, r.compiled!.accounts, locale);
    const p = await this.deps.live().prepareCompiledMandate(c.accountId, c.mandate, locale);
    await sql`update trading_mandates set state = 'pending_signer', compiled = ${sql.json({ accounts: r.compiled!.accounts, venue: { accountId: c.accountId, mandate: c.mandate, hash: p.hash, derived: c.derived } } as never)}, enforcement = ${sql.json(c.enforcement as never)}, updated_at = now() where id = ${r.id}`;
    // the API's own passkey step: ONE intent that names the full trading mandate hash and the hash of the derivative mandate compiled from it
    const b = await prepareIntent<MandateApprovalIntent>(this.deps.passkey, MANDATE_APPROVAL_DOMAIN, approvalKey(r.id), { v: 1, kind: 'trading_mandate_approval', mandateId: r.id, tradingMandateHash: r.hash,
      principal: `${r.principal_kind}:${r.principal_id}`, mode: 'live', signer: { shape: 'SPW-VENUE-MANDATE-v1', mandateHash: p.hash } });
    return { ...base, kind: 'directional' as const, enforcement: c.enforcement, derived: c.derived, passkey: true as const,
      signer: { shape: 'SPW-VENUE-MANDATE-v1', accountId: c.accountId, mandate: p.mandate, hash: p.hash, acknowledgement: p.acknowledgement, warning: p.warning, enforcedBySigner: p.enforcedBySigner, trustedBySigner: p.trustedBySigner, notEnforced: p.notEnforced,
        windDown: p.windDown, options: p.options },
      /** the second passkey prompt: its challenge is the hash of `intent`, which names the FULL mandate hash shown on the sheet */
      binding: { domain: MANDATE_APPROVAL_DOMAIN, intent: b.intent, hash: b.hash, options: b.options, expiresAt: b.expiresAt },
      note: 'two passkey prompts. (1) The isolated signer verifies the passkey over the hash of the compiled derivative mandate — what it stores and enforces. (2) The API verifies the passkey over an intent that names the FULL trading mandate hash (every field, the "API only" ones included) and that derivative mandate; the assertion is stored and verified again each time the mandate is used. (2) is checked by the API: it protects the record against alteration, not against a compromised API.' };
  }

  /** the approval sheet of a QUOTING mandate: the enforced-by table verbatim, the hashes, the acknowledgement, and the two WebAuthn requests */
  private async prepareQuotingApproval<B extends object>(r: Row, base: B, locale: 'fr' | 'en') {
    const q = r.quoting!, qs = this.quotingSigner();
    if (sectionHash(q.section) !== q.hash) throw new UserError('mandate_integrity', 'the stored quoting section does not hash to its recorded hash: create the mandate again', 409);
    // the agent's configuration must still be the one the section names: a change since the creation makes the mandate stale
    const agent = await quotingAgent(r.principal_id);
    if (agent.configSha256 !== q.section.engine.configSha256) throw new UserError('quoting_config_changed', 'the agent\'s configuration changed since this mandate was created: create a new mandate for the current configuration', 409);
    const c = await this.compileQuotingFor(r.mandate, q.section, r.compiled!.accounts, locale);
    const st = await qs.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    await this.deps.live().deps.venues.get(c.binding.network).assertPinned();
    const signerHash = hex(venueQuotingMandateHash(c.mandate));
    await sql`update trading_mandates set state = 'pending_signer', compiled = ${sql.json({ accounts: r.compiled!.accounts, venue: { accountId: c.accountId, mandate: c.mandate, hash: signerHash, derived: c.derived } } as never)}, enforcement = ${sql.json(c.enforcement as never)}, updated_at = now() where id = ${r.id}`;
    const b = await prepareIntent<MandateApprovalIntent>(this.deps.passkey!, MANDATE_APPROVAL_DOMAIN, approvalKey(r.id), { v: 1, kind: 'trading_mandate_approval', mandateId: r.id, tradingMandateHash: r.hash,
      principal: `${r.principal_kind}:${r.principal_id}`, mode: 'live', signer: { shape: QUOTING_SHAPE, mandateHash: signerHash }, quotingSectionHash: q.hash });
    return { ...base, kind: 'quoting' as const, enforcement: c.enforcement, derived: c.derived, passkey: true as const,
      quoting: { section: q.section, hash: q.hash, termsEnforcement: c.termsEnforcement, sectionEnforcement: c.sectionEnforcement, maxima: c.maxima,
        /** the whole enforced-by table as Markdown: the sheet shows it VERBATIM */ table: c.table },
      signer: { shape: QUOTING_SHAPE, accountId: c.accountId, mandate: c.mandate, hash: signerHash, acknowledgement: c.binding.ack, options: await webauthnOptions(this.deps.passkey!, Buffer.from(signerHash, 'hex')),
        windDown: { seconds: TRADING_MANDATE_WIND_DOWN_S }, exclusivity: 'no directional mandate can be active on this venue account while this quoting mandate is, and vice versa' },
      binding: { domain: MANDATE_APPROVAL_DOMAIN, intent: b.intent, hash: b.hash, options: b.options, expiresAt: b.expiresAt },
      hashes: { tradingMandate: r.hash, quotingSection: q.hash, signerMandate: signerHash, approvalIntent: b.hash },
      note: 'two passkey prompts. (1) The isolated signer verifies the passkey over the hash of the quoting mandate — what it stores and enforces on every quote. (2) The API verifies the passkey over an intent that names the FULL trading mandate hash, the hash of the quoting section (quote rates, geometry, session settings) and that quoting mandate; the assertion is stored and verified again each time the mandate is used.' };
  }
  /** V11 market making: step 2 at the signer. An answer that never came back is NOT a refusal: the row stays `pending_signer` and `recoverQuoting` settles it. */
  private async approveQuotingAtSigner(r: Row, assertion: unknown): Promise<{ hash: string }> {
    const v = r.compiled!.venue!, qs = this.quotingSigner();
    let out: Awaited<ReturnType<QuotingSignerPort['venueQuotingApprove']>>;
    try { out = await qs.venueQuotingApprove(v.mandate, assertion); }
    catch (e) {
      const code = e instanceof UserError ? e.code : 'internal';
      if (code === 'signer_unreachable' || code === 'signer_error' || code === 'internal') {
        await audit('mandate.approval_unknown', 'owner', { mandateId: r.id, reason: msg(e) }).catch(() => {});
        throw new UserError('quoting_approval_unknown', `the signer gave no usable answer (${msg(e)}): it may or may not have stored the quoting mandate. Use "recover" on this mandate: it asks the signer, then activates the mandate or leaves it to be approved again.`, 503);
      }
      await sql`update trading_mandates set state = 'failed', updated_at = now() where id = ${r.id} and state = 'pending_signer'`;
      await audit('mandate.approval_refused', 'owner', { mandateId: r.id, reason: msg(e) }).catch(() => {});
      throw e;
    }
    if (out.mandateId !== r.id || (v.hash && out.hash !== v.hash)) {
      await qs.venueQuotingRevoke(out.mandateId).catch(() => {});
      await sql`update trading_mandates set state = 'failed', updated_at = now() where id = ${r.id}`;
      throw new UserError('bad_state', 'the mandate the signer approved is not the one compiled from this trading mandate; it was revoked and not activated', 409);
    }
    return { hash: out.hash };
  }
  private async activate(r: Row): Promise<void> {
    const at = new Date(this.now());
    const done = await sql`update trading_mandates set state = 'active', approved_at = ${at}, updated_at = ${at} where id = ${r.id} and state in ('created', 'pending_signer') returning id`;
    if (!done.length) throw new UserError('bad_state', 'the mandate changed concurrently', 409);
    const equity = await this.equityOf(r).catch(() => null);
    await sql`insert into trading_mandate_usage (mandate_id, start_equity, peak_equity) values (${r.id}, ${equity}, ${equity}) on conflict (mandate_id) do update set start_equity = excluded.start_equity, peak_equity = excluded.peak_equity`;
    await audit('mandate.approved', 'owner', { mandateId: r.id, hash: r.hash, kind: r.quoting ? 'quoting' : 'directional', principal: `${r.principal_kind}:${r.principal_id}`, mode: r.mode, passkey: r.mode === 'live', enforcement: Object.fromEntries(r.enforcement.map((e) => [e.field, e.enforcedBy])) }).catch(() => {});
  }
  /**
   * V11 market making — the lost answer of a quoting approval, and orphans. Asks the signer what it holds:
   *  - a `pending_signer` quoting row whose stored passkey approval verifies and whose compiled mandate the signer holds ACTIVE
   *    with the same hash → activated (the owner did approve it; only the answer was lost);
   *  - a quoting mandate the signer holds active that no active or pending row of this wallet accounts for, or whose stored
   *    approval does not verify → revoked at the signer (stopping never needs a passkey).
   */
  async recoverQuoting(): Promise<{ adopted: string[]; revoked: string[]; pending: string[] }> {
    const qs = this.quotingSigner(), st = await qs.status(true), held = (st.venueQuotingMandates ?? []).filter((x) => x.phase === 'active' && !x.revoked);
    const out = { adopted: [] as string[], revoked: [] as string[], pending: [] as string[] };
    const rows = await sql<Row[]>`select * from trading_mandates where quoting is not null and state in ('pending_signer', 'active')`;
    for (const r of rows.filter((x) => x.state === 'pending_signer')) {
      const h = held.find((x) => x.mandate.mandateId === r.id), v = r.compiled?.venue, a = r.approval;
      if (!h) { out.pending.push(r.id); continue; }
      const sound = v?.hash === h.hash && !!a && a.intent.mandateId === r.id && a.intent.tradingMandateHash === r.hash && a.intent.signer.mandateHash === h.hash && a.intent.quotingSectionHash === r.quoting!.hash
        && hex(canonicalIntentHash(MANDATE_APPROVAL_DOMAIN, a.intent)) === a.hash && !!this.deps.reverify && await this.deps.reverify(a.assertion, Buffer.from(a.hash, 'hex')).then(() => true, () => false);
      if (!sound) { await qs.venueQuotingRevoke(r.id); await sql`update trading_mandates set state = 'failed', updated_at = now() where id = ${r.id}`; out.revoked.push(r.id); await audit('mandate.quoting_orphan_revoked', 'system', { mandateId: r.id, reason: 'the signer held it, the stored approval did not verify' }).catch(() => {}); continue; }
      await sql`update trading_mandates set signer = ${sql.json({ shape: QUOTING_SHAPE, accountId: v!.accountId, mandateId: r.id, hash: h.hash } as never)} where id = ${r.id}`;
      await this.activate(r); out.adopted.push(r.id);
      await audit('mandate.quoting_recovered', 'owner', { mandateId: r.id, hash: h.hash }).catch(() => {});
    }
    const known = new Set(rows.map((r) => r.id));
    for (const h of held) if (!known.has(h.mandate.mandateId)) { await qs.venueQuotingRevoke(h.mandate.mandateId); out.revoked.push(h.mandate.mandateId); await audit('mandate.quoting_orphan_revoked', 'system', { mandateId: h.mandate.mandateId, reason: 'no record of this wallet accounts for it' }).catch(() => {}); }
    return out;
  }

  async approve(id: string, body: { assertion?: Record<string, unknown>; bindingAssertion?: Record<string, unknown>; acknowledged?: boolean }) {
    const r = await this.row(id), nowSec = Math.floor(this.now() / 1000);
    if (r.state === 'active') return this.view(r);
    if (r.mandate.notAfter <= nowSec) throw new UserError('mandate_expired', 'the mandate has expired before its approval: create a new one', 410);
    if (tradingMandateHashHex(r.mandate) !== r.hash) throw new UserError('mandate_integrity', 'the stored mandate does not hash to its recorded hash: create it again', 409);
    if (r.mode === 'paper') {
      if (r.state !== 'created') throw new UserError('bad_state', `the mandate is ${r.state}`, 409);
    } else {
      if (r.state !== 'pending_signer' || !r.compiled?.venue) throw new UserError('bad_state', 'prepare the approval first', 409);
      if (!body.assertion || !body.bindingAssertion || body.acknowledged !== true) throw new UserError('passkey_required', 'a live mandate is approved with the owner\'s passkey, twice — once for the isolated signer (the derivative mandate), once for the full mandate hash (`bindingAssertion`) — after the acknowledgement was displayed', 403);
      if (!this.deps.passkey?.verifyOwner) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval: a live mandate cannot be approved', 503);
      const v = r.compiled.venue, live = this.deps.live();
      for (const a of r.compiled.accounts) { await this.refuseOtherKind(a.accountId, r.id, r.quoting !== null && r.quoting !== undefined); await this.refuseSecondPrincipal(a.accountId, r.id, { kind: r.principal_kind, id: r.principal_id }); }
      if (r.quoting) { const lock = quotingNetworkLock((r.compiled.venue.mandate as VenueQuotingMandate).network, this.deps.mmLocks?.()); if (lock) throw lock; }
      // (2) first: the full-hash approval is verified, taken once, and stored BEFORE the signer is asked — a mandate can reach the
      // signer only together with the owner's commitment to every one of its fields
      const intent = await takeIntent<MandateApprovalIntent>(this.deps.passkey, MANDATE_APPROVAL_DOMAIN, approvalKey(r.id), body.bindingAssertion, 'mandate.binding_refused');
      if (intent.kind !== 'trading_mandate_approval' || intent.mandateId !== r.id || intent.tradingMandateHash !== r.hash || intent.signer.mandateHash !== v.hash || intent.quotingSectionHash !== (r.quoting?.hash ?? undefined)
        || intent.signer.shape !== (r.quoting ? QUOTING_SHAPE : 'SPW-VENUE-MANDATE-v1')) throw new UserError('bad_state', 'the prepared approval is not for this mandate as it is stored: prepare it again', 409);
      const approval: MandateApproval = { v: 1, domain: MANDATE_APPROVAL_DOMAIN, intent, hash: hex(canonicalIntentHash(MANDATE_APPROVAL_DOMAIN, intent)), assertion: body.bindingAssertion,
        credentialId: typeof body.bindingAssertion.id === 'string' ? body.bindingAssertion.id.slice(0, 1024) : null, approvedAt: this.now() };
      await sql`update trading_mandates set approval = ${sql.json(approval as never)}, updated_at = now() where id = ${r.id} and state = 'pending_signer'`;
      if (r.quoting) {
        const out = await this.approveQuotingAtSigner(r, body.assertion);
        await sql`update trading_mandates set signer = ${sql.json({ shape: QUOTING_SHAPE, accountId: v.accountId, mandateId: r.id, hash: out.hash } as never)} where id = ${r.id}`;
        await audit('mandate.quoting_acknowledged', 'owner', { mandateId: r.id, signerMandateHash: out.hash, ackSha256: (v.mandate as VenueQuotingMandate).ackSha256,
          statement: 'the owner confirmed again with his passkey having read the jurisdiction summary; letting an automated strategy QUOTE derivatives on this venue inside the mandate is his own decision' }).catch(() => {});
        await this.activate(r);
        return this.get(r.id);
      }
      try { await live.approveMandate(v.accountId, { assertion: body.assertion, acknowledged: true }); }
      catch (e) {
        await sql`update trading_mandates set state = 'failed', updated_at = now() where id = ${r.id} and state = 'pending_signer'`;
        await audit('mandate.approval_refused', 'owner', { mandateId: r.id, reason: msg(e) }).catch(() => {});
        throw e;
      }
      // the signer approved A mandate: it must be exactly the one compiled from this trading mandate (same id, same hash)
      const [dm] = await sql<{ id: string; state: string; hash: string }[]>`select id, state, hash from deriv_mandates where id = ${r.id}`;
      if (!dm || dm.state !== 'active' || (v.hash && dm.hash !== v.hash)) {
        await sql`update trading_mandates set state = 'failed', updated_at = now() where id = ${r.id}`;
        throw new UserError('bad_state', 'the mandate the signer approved is not the one compiled from this trading mandate; it was not activated', 409);
      }
      await sql`update trading_mandates set signer = ${sql.json({ shape: 'SPW-VENUE-MANDATE-v1', accountId: v.accountId, mandateId: dm.id, hash: dm.hash } as never)} where id = ${r.id}`;
    }
    const at = new Date(this.now());
    const done = await sql`update trading_mandates set state = 'active', approved_at = ${at}, updated_at = ${at} where id = ${r.id} and state in ('created', 'pending_signer') returning id`;
    if (!done.length) throw new UserError('bad_state', 'the mandate changed concurrently', 409);
    const equity = await this.equityOf(r).catch(() => null);
    await sql`insert into trading_mandate_usage (mandate_id, start_equity, peak_equity) values (${r.id}, ${equity}, ${equity}) on conflict (mandate_id) do update set start_equity = excluded.start_equity, peak_equity = excluded.peak_equity`;
    await audit('mandate.approved', 'owner', { mandateId: r.id, hash: r.hash, principal: `${r.principal_kind}:${r.principal_id}`, mode: r.mode, passkey: r.mode === 'live', enforcement: Object.fromEntries(r.enforcement.map((e) => [e.field, e.enforcedBy])) }).catch(() => {});
    return this.get(r.id);
  }

  // ------------------------------------------------------------------ revocation, wind-down
  /** final. Owner: `owner_request`; supervisor: `stop_condition`. Live: revoked at the signer FIRST (no new exposure is signed from that instant). */
  async revoke(id: string, o: { by: 'owner' | 'system'; reason: 'owner_request' | 'stop_condition' | 'key_compromise' | 'superseded' | 'kill_switch'; detail?: string | null; cancelOpenOrders?: boolean }) {
    const r = await this.row(id);
    if (r.state === 'revoked') return { mandate: await this.view(r), cancelled: 0, signerRevoked: null as boolean | null, signerError: null as string | null };
    if (r.state !== 'active') {
      await sql`update trading_mandates set state = 'revoked', revoked_at = now(), updated_at = now() where id = ${r.id}`;
      return { mandate: await this.get(r.id), cancelled: 0, signerRevoked: null as boolean | null, signerError: null as string | null };
    }
    // the API stops accepting orders under the mandate at once, whatever the signer answers; a signer that could not be reached
    // is asked again by the supervisor until it has revoked its own copy (it signs nothing while it is unreachable)
    const sg = await this.revokeAtSigner(r);
    const at = new Date(this.now());
    const revocation = revokeTradingMandate(r.mandate, { revokedAt: Math.floor(at.getTime() / 1000), revokedBy: { kind: o.by, id: o.by === 'owner' ? 'owner' : 'supervisor' }, reason: o.reason, supersededBy: null, detail: o.detail?.slice(0, 300) ?? null });
    await sql`update trading_mandates set state = 'revoked', revoked_at = ${at}, revocation = ${sql.json({ record: revocation, signerRevoked: sg.revoked, signerError: sg.error } as never)}, stop = ${o.reason === 'stop_condition' ? sql.json({ code: (o.detail ?? '').split(':')[0], at: at.getTime(), detail: o.detail ?? '' } as never) : null}, updated_at = ${at}
      where id = ${r.id} and state = 'active'`;
    await audit('mandate.revoked', o.by === 'owner' ? 'owner' : 'supervisor', { mandateId: r.id, reason: o.reason, detail: o.detail ?? null, signerRevoked: sg.revoked, signerError: sg.error, windDownUntil: (Math.floor(at.getTime() / 1000) + TRADING_MANDATE_WIND_DOWN_S) * 1000 }).catch(() => {});
    // wind-down: what rests and could add risk is cancelled; reductions stay possible until the wind-down ends
    let cancelled = 0;
    if (o.cancelOpenOrders !== false && this.deps.cancelResting) cancelled = await this.deps.cancelResting(r.id).catch((e: unknown) => { console.error(`[mandates] wind-down cancel of ${r.id}: ${msg(e)}`); return 0; });
    return { mandate: await this.get(r.id), cancelled, signerRevoked: sg.revoked, signerError: sg.error };
  }
  /** null = nothing to revoke at the signer (paper, or never approved there) */
  private async revokeAtSigner(r: Row): Promise<{ revoked: boolean | null; error: string | null }> {
    if (r.mode !== 'live' || !r.signer) return { revoked: null, error: null };
    if (r.signer.shape === QUOTING_SHAPE) {
      // quoting: revoked at the signer by its id; a signer that never stored it has nothing to revoke
      try { await this.quotingSigner().venueQuotingRevoke(r.signer.mandateId); return { revoked: true, error: null }; }
      catch (e) { return e instanceof UserError && e.code === 'signer_not_found' ? { revoked: true, error: null } : { revoked: false, error: msg(e) }; }
    }
    const [dm] = await sql<{ state: string }[]>`select state from deriv_mandates where id = ${r.signer.mandateId}`;
    if (dm?.state !== 'active') return { revoked: true, error: null };
    try { await this.deps.live().revokeMandate(r.signer.accountId, { cancelOpenOrders: false }); return { revoked: true, error: null }; }
    catch (e) { return { revoked: false, error: msg(e) }; }
  }

  // ------------------------------------------------------------------ binding and order checks
  /** `api_keys.mandate_id`: the mandate exists, is approved and active, and was approved for THIS key */
  async verifyKeyBinding(keyId: string, mandateId: string): Promise<void> {
    const [r] = await sql<Row[]>`select * from trading_mandates where id = ${mandateId}`;
    if (!r) throw new UserError('mandate_not_found', 'no trading mandate with this id', 422);
    if (r.principal_kind !== 'api_key' || r.principal_id !== keyId) throw new UserError('mandate_principal_mismatch', 'this mandate was approved for another principal', 422);
    if (r.state !== 'active' || this.phase(r) !== 'active') throw new UserError('mandate_not_active', `this mandate is ${r.state === 'active' ? this.phase(r) : r.state}: only an approved, active mandate can be bound`, 422);
    const bad = await this.integrity(r);
    if (bad) throw new UserError('mandate_integrity', `this mandate cannot be used: ${bad}`, 422);
  }

  /** the mandate a principal acts under, or the refusal. Revoked and expired mandates are returned: `checkOrder` decides (reductions pass during the wind-down). */
  async forPrincipal(p: { kind: 'agent' | 'api_key'; id: string }, mandateId: string | null): Promise<Row> {
    if (!mandateId) throw new UserError('mandate_required', 'this principal has no trading mandate: nothing it asks can execute', 403);
    const [r] = await sql<Row[]>`select * from trading_mandates where id = ${mandateId}`;
    if (!r || r.principal_kind !== p.kind || r.principal_id !== p.id) throw new UserError('mandate_required', 'the mandate bound to this principal does not exist or was approved for another principal', 403);
    if (r.state !== 'active' && r.state !== 'revoked') throw new UserError('mandate_not_approved', 'the mandate bound to this principal was never approved', 403);
    // the row is used for enforcement from here: it must still be exactly what the owner approved (a tampered row is unusable)
    const bad = await this.integrity(r);
    if (bad) {
      await audit('mandate.integrity_failed', 'system', { mandateId: r.id, reason: bad }).catch(() => {});
      throw new UserError('mandate_integrity', `the mandate bound to this principal cannot be used: ${bad}`, 403);
    }
    return r;
  }

  private async equityOf(r: Row): Promise<DecStr | null> {
    const ids = (r.compiled?.accounts ?? []).map((a) => a.accountId);
    if (r.mode === 'paper') {
      const list = (await this.deps.derivatives().paper.list()).filter((a) => ids.includes(a.id));
      return list.length ? D.str(list.reduce((s, a) => D.add(s, D.from(a.state.equity)), D.zero)) : null;
    }
    let sum = D.zero;
    for (const id of ids) { const s = await this.deps.live().mandateAccountState(id); if (!s.state) return null; sum = D.add(sum, D.from(s.state.equity)); }
    return D.str(sum);
  }

  /** the measurements `checkOrder` needs, from the evaluation the risk engine just made and from this service's own counters */
  async usageFor(r: Row, order: CanonicalOrder, accountId: string | null, ev: Pick<Evaluated, 'reducing' | 'derived' | 'market' | 'leverage' | 'accounts'>, exceptOrderId: string | null): Promise<TradingMandateUsage> {
    const now = this.now(), u = await this.usageRow(r.id), ids = (r.compiled?.accounts ?? []).map((a) => a.accountId);
    const mine = ev.accounts.filter((a) => ids.includes(a.accountId));
    const equity = D.str(mine.reduce((s, a) => D.add(s, D.from(a.equity)), D.zero)), marginUsed = mine.reduce((s, a) => D.add(s, D.from(a.marginUsed)), D.zero);
    const ref = ev.derived.referencePrice, before = D.abs(D.from(ev.derived.positionBefore)), after = ev.derived.positionAfter === null ? null : D.abs(D.from(ev.derived.positionAfter));
    const lev = order.leverage ?? ev.leverage;
    const added = ref !== null && after !== null && D.gt(after, before) && lev !== null && D.isPos(D.from(lev)) ? D.div(D.mul(D.sub(after, before), D.from(ref)), D.from(lev), 6, 'up') : D.zero;
    const [f] = ids.length ? await sql<{ pnl: string }[]>`select coalesce(sum(coalesce(closed_pnl, 0) - fee), 0)::text as pnl from deriv_fills where account_id::text = any(${ids}) and ts >= ${new Date(dayStart(now))}` : [{ pnl: '0' }];
    const [c] = await sql<{ minute: number; hour: number; today: number }[]>`select count(*) filter (where created_at > ${new Date(now - 60_000)})::int as minute, count(*) filter (where created_at > ${new Date(now - 3_600_000)})::int as hour,
      count(*) filter (where created_at >= ${new Date(dayStart(now))})::int as today from orders where mandate_id = ${r.id} and not reduce_only and state not in ('REJECTED', 'FAILED') and id <> ${exceptOrderId ?? ''}`;
    const start = u.start_equity === null ? null : D.from(u.start_equity), peak = u.peak_equity === null ? D.from(equity) : D.max(D.from(u.peak_equity), D.from(equity));
    const dd = D.isPos(peak) ? Number(D.str(D.div(D.mul(D.max(D.sub(peak, D.from(equity)), D.zero), D.from(10000n)), peak, 0, 'down'))) : 0;
    const account = (r.compiled?.accounts ?? []).find((a) => a.accountId === accountId)?.account ?? { kind: 'venue_account' as const, venue: order.venue, network: order.network, account: accountId ?? 'unknown' };
    const ticker = ev.market.ticker;
    return {
      revokedAt: r.revoked_at ? Math.floor(r.revoked_at.getTime() / 1000) : null, account, reducing: ev.reducing, referencePrice: ref,
      positionNotionalAfterUsd: ref !== null && after !== null ? D.str(D.mul(after, D.from(ref))) : '0', capitalInUseAfterUsd: D.str(D.add(marginUsed, added)), equityUsd: equity,
      realizedLossTodayUsd: D.str(D.max(D.neg(D.from(f!.pnl)), D.zero)), totalLossUsd: start === null ? '0' : D.str(D.max(D.sub(start, D.from(equity)), D.zero)), drawdownBps: dd,
      ordersLastMinute: c!.minute, ordersLastHour: c!.hour, ordersToday: c!.today, consecutiveRejects: u.consecutive_rejects,
      dataStaleMs: ticker ? Math.max(0, now - ticker.ts) : 86_400_000, signerUnreachableMs: u.signer_unreachable_since ? Math.max(0, now - u.signer_unreachable_since.getTime()) : 0, leverageSetting: ev.leverage,
    };
  }

  /** does the order fit the mandate? Every reason is returned. */
  async check(r: Row, order: CanonicalOrder, accountId: string | null, ev: Pick<Evaluated, 'reducing' | 'derived' | 'market' | 'leverage' | 'accounts'>, exceptOrderId: string | null): Promise<MandateDecision> {
    return checkTradingMandateOrder(r.mandate, order, await this.usageFor(r, order, accountId, ev, exceptOrderId), this.now());
  }

  /** counters of the mandate, after an order under it was accepted (it reached APPROVED) or refused */
  async recordOutcome(mandateId: string, o: { accepted: boolean; notionalUsd: DecStr | null }): Promise<void> {
    await this.usageRow(mandateId);
    if (o.accepted) await sql`update trading_mandate_usage set orders_accepted = orders_accepted + 1, consecutive_rejects = 0, notional_total = notional_total + ${o.notionalUsd ?? '0'}, last_order_at = ${new Date(this.now())}, updated_at = now() where mandate_id = ${mandateId}`;
    else await sql`update trading_mandate_usage set orders_rejected = orders_rejected + 1, consecutive_rejects = consecutive_rejects + 1, updated_at = now() where mandate_id = ${mandateId}`;
  }

  // ------------------------------------------------------------------ supervisor
  /** one pass over the active mandates: expiry is by date (nothing to do); a stop condition that is met engages the wind-down */
  async supervise(): Promise<{ checked: number; stopped: string[] }> {
    const rows = await sql<Row[]>`select * from trading_mandates where state = 'active'`, stopped: string[] = [], now = this.now();
    const signerUp = await this.deps.signerStatus().then(() => true, () => false);
    // a revocation the signer has not taken yet is asked again
    for (const r of await sql<Row[]>`select * from trading_mandates where state = 'revoked' and mode = 'live' and revocation->>'signerRevoked' = 'false'`) {
      const sg = await this.revokeAtSigner(r);
      if (sg.revoked) await sql`update trading_mandates set revocation = revocation || ${sql.json({ signerRevoked: true, signerError: null } as never)}, updated_at = now() where id = ${r.id}`;
    }
    for (const r of rows) {
      if (this.phase(r) !== 'active') continue;
      // a row that is no longer what the owner approved: stopped for good, at the signer too (it signs nothing more that adds exposure)
      const bad = await this.integrity(r);
      if (bad) {
        try { await this.revoke(r.id, { by: 'system', reason: 'key_compromise', detail: `MANDATE_INTEGRITY: ${bad}`, cancelOpenOrders: true }); stopped.push(r.id); }
        catch (e) { console.error(`[mandates] ${r.id} failed its integrity check and could not be revoked: ${msg(e)}`); }
        continue;
      }
      const u = await this.usageRow(r.id);
      if (r.mode === 'live') {
        if (signerUp && u.signer_unreachable_since) await sql`update trading_mandate_usage set signer_unreachable_since = null where mandate_id = ${r.id}`;
        if (!signerUp && !u.signer_unreachable_since) await sql`update trading_mandate_usage set signer_unreachable_since = ${new Date(now)} where mandate_id = ${r.id}`;
      }
      // a quoting mandate's account is followed by its session from the venue's streams: this loop reads its equity once a minute, not at every pass (IP weight)
      const seen = this.quotingEquity.get(r.id), reuse = !!r.quoting && !!seen && now - seen.at < 60_000;
      const equity = reuse ? seen!.equity : await this.equityOf(r).catch(() => null);
      if (r.quoting && !reuse) this.quotingEquity.set(r.id, { at: now, equity });
      if (equity !== null && (u.peak_equity === null || D.gt(D.from(equity), D.from(u.peak_equity)))) await sql`update trading_mandate_usage set peak_equity = ${equity} where mandate_id = ${r.id}`;
      const peak = equity === null ? null : u.peak_equity === null ? D.from(equity) : D.max(D.from(u.peak_equity), D.from(equity));
      let why: string | null = null;
      for (const s of r.mandate.stopConditions) {
        if (s.kind === 'loss_gte' && equity !== null && u.start_equity !== null && D.gte(D.sub(D.from(u.start_equity), D.from(equity)), D.from(s.usd))) why = `STOP_LOSS_GTE: loss ${D.str(D.sub(D.from(u.start_equity), D.from(equity)))} USD reached ${s.usd}`;
        else if (s.kind === 'drawdown_gte' && equity !== null && peak !== null && D.isPos(peak) && D.gte(D.mul(D.sub(peak, D.from(equity)), D.from(10000n)), D.mul(D.from(BigInt(s.bps)), peak))) why = `STOP_DRAWDOWN_GTE: equity ${equity} against a peak of ${D.str(peak)} reached ${s.bps} bps`;
        else if (s.kind === 'consecutive_rejects_gte' && u.consecutive_rejects >= s.count) why = `STOP_CONSECUTIVE_REJECTS_GTE: ${u.consecutive_rejects} consecutive refusals reached ${s.count}`;
        else if (s.kind === 'signer_unreachable_gte' && r.mode === 'live' && !signerUp && u.signer_unreachable_since && now - u.signer_unreachable_since.getTime() >= s.ms) why = `STOP_SIGNER_UNREACHABLE_GTE: the signer has been unreachable for ${now - u.signer_unreachable_since.getTime()} ms`;
        // data_stale_gte is judged per order (the age of the data the order is priced on): checkOrder refuses it then
        if (why) break;
      }
      if (why) {
        try { await this.revoke(r.id, { by: 'system', reason: 'stop_condition', detail: why, cancelOpenOrders: true }); stopped.push(r.id); }
        catch (e) { console.error(`[mandates] stop condition of ${r.id} could not engage the wind-down: ${msg(e)}`); }
      }
    }
    return { checked: rows.length, stopped };
  }
}
export type MandateRow = Row;
