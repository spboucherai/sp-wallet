// QUOTING mandates on the API side: what the mandate service (mandates/service.ts) needs to carry a market-making mandate
// through the SAME lifecycle as any trading mandate — created by the owner, approved with the passkey, active, used, stopped,
// revoked at the signer first. A quoting mandate is a `trading_mandates` row whose `quoting` column holds the sibling record
// `SPW-QUOTING-SECTION-v1` (@spw/trading): the quote rates and geometry (compiled one to one into the signer's
// `SPW-VENUE-QUOTING-MANDATE-v1`) and the API-only session settings. ONE passkey-bound intent names the trading mandate hash,
// the section hash and the signer mandate hash: nothing the owner approved lives outside what the passkey covers.
//
// What is refused here, with a code, before anything is stored:
//   quoting_requires_agent              the principal is an API key (a quoting mandate is for a market-making agent)
//   not_market_making_agent             the agent is of another family
//   live_unavailable                    the agent's venue or instrument cannot go live (liveVerdict)
//   quoting_instrument_mismatch         the mandate does not list exactly the agent's one instrument
//   quoting_config_mismatch             the section does not say what the agent's configuration says (policy, quote size, spread)
//   strategy_hash_mismatch              the mandate is not for the agent's rule version
//   value_not_expressible / exceeds_authorization / …   a value above a compiled bound or the venue authorization (never clamped)
//   mm_mainnet_disabled / mm_testnet_disabled           the server lock of quoting on that network is off
import { z } from 'zod';
import type { VenueAuthorization, VenueQuotingMandate } from '@spw/derivatives/live';
import {
  compileToQuotingMandate, QUOTING_POLICIES, quotingSectionEnforcement, quotingSectionHashHex, quotingSectionMaxima, QuotingTermsSchema, renderQuotingApprovalTable, TradingMandateError, validateQuotingSection,
  type FieldEnforcement, type QuotingSection, type SectionEnforcement, type TermEnforcement, type TradingMandate,
} from '@spw/trading';
import { BREAKER_CODES } from '@spw/trading/mm';
import { UserError } from '../config.ts';
import { configHash, FAMILY_MODES, liveVerdict, LIVE_VENUE, RULES, ruleHash, type Family } from '../agent-runtime/model.ts';
import { loadAgent } from '../agent-runtime/store.ts';
import { envMmLocks, mmOpeningLock, type MmLocks } from './live-adapter.ts';

export const QUOTING_SHAPE = 'SPW-VENUE-QUOTING-MANDATE-v1' as const;
const Dec = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/);
/** the `quoting` section of a mandate creation: the owner's values. `mandateId`, `tradingMandateHash` and `configSha256` are computed by the service. */
export const QuotingCreateSchema = z.strictObject({
  terms: QuotingTermsSchema,
  engine: z.strictObject({
    policy: z.enum(QUOTING_POLICIES), quoteSizeUsd: Dec, softInventoryUsd: Dec, hardInventoryUsd: Dec, maxSessionMinutes: z.number().int(),
    hours: z.strictObject({ startUtcMinute: z.number().int().min(0).max(1439), endUtcMinute: z.number().int().min(0).max(1439) }).nullable().default(null),
    maxSessionLossUsd: Dec, stopBeforeExpiryS: z.number().int().default(300), breakers: z.partialRecord(z.enum(BREAKER_CODES), z.enum(['pull', 'flatten', 'halt'])).default({}), flattenOnStop: z.boolean().default(false),
  }),
});
export type QuotingCreate = z.infer<typeof QuotingCreateSchema>;
/** what is stored in `trading_mandates.quoting` */
export interface StoredQuoting { section: QuotingSection; hash: string; termsEnforcement: TermEnforcement[]; sectionEnforcement: SectionEnforcement[]; maxima: Record<string, string>; agent: { id: string; rule: string; configVersion: number; instrument: string } }
/** the signer's quoting endpoints as the mandate service uses them */
export interface QuotingSignerPort {
  venueQuotingApprove(mandate: unknown, assertion: unknown): Promise<{ mandateId: string; hash: string; authorizationId: string }>;
  venueQuotingRevoke(mandateId: string): Promise<{ revoked: true; revokedAt: string; windDownUntil: number }>;
  status(fresh?: boolean): Promise<{ halted: boolean; venueQuotingMandates?: { mandate: { mandateId: string; authorizationId: string; account: string; network: string }; hash: string; revoked: boolean; phase: 'active' | 'wind_down' | 'ended' }[] }>;
}

const asUser = (e: unknown, status = 422): never => { if (e instanceof TradingMandateError) throw new UserError(e.code, `${e.field ? `${e.field}: ` : ''}${e.message}`, status); throw e; };

/** the agent a quoting mandate is for, as it is NOW: family, the one instrument it quotes, its rule and the hash of its configuration */
export async function quotingAgent(agentId: string): Promise<{ id: string; rule: string; ruleSha256: string; configSha256: string; configVersion: number; config: Record<string, unknown>; instrument: string; venues: string[] }> {
  const a = await loadAgent(agentId), family = (a.family ?? 'custom') as Family, rt = (a.runtime ?? {}) as { venues?: string[]; rule?: string; config?: Record<string, unknown> };
  if (family !== 'market_making' || (a.kind ?? 'spot') !== 'stream' || !rt.rule || !RULES[rt.rule]) throw new UserError('not_market_making_agent', 'a quoting mandate is approved for a market-making agent (created from the market-making template)', 422);
  const lv = liveVerdict(family, 'stream', a.universe, rt.venues ?? []);
  if (!lv.capable) throw new UserError('live_unavailable', lv.reason, 409);
  if (!FAMILY_MODES[family].modes.includes('live')) throw new UserError('live_unavailable', FAMILY_MODES[family].liveReason ?? 'live mode is not available', 409);
  return { id: a.id, rule: rt.rule, ruleSha256: ruleHash(rt.rule), configSha256: configHash(rt.config ?? {}), configVersion: a.config_version ?? 1, config: rt.config ?? {}, instrument: `${LIVE_VENUE}:${a.universe[0]}`, venues: rt.venues ?? [] };
}

/** the section of a mandate, built from the owner's values and checked against the mandate and the agent's configuration */
export function buildQuotingSection(mandate: TradingMandate, mandateHash: string, body: QuotingCreate, agent: Awaited<ReturnType<typeof quotingAgent>>): QuotingSection {
  if (mandate.principal.kind !== 'agent' || mandate.principal.id !== agent.id) throw new UserError('quoting_requires_agent', 'a quoting mandate is approved for a market-making AGENT, never for an API key', 422);
  if (mandate.mode !== 'live') throw new UserError('quoting_requires_live', 'a quoting mandate is a live mandate: paper market making needs no mandate of this kind', 422);
  if (mandate.instruments.length !== 1 || mandate.instruments[0] !== agent.instrument) throw new UserError('quoting_instrument_mismatch', `the mandate must list exactly the instrument the agent quotes (${agent.instrument})`, 422);
  if (mandate.strategySha256 !== agent.ruleSha256) throw new UserError('strategy_hash_mismatch', `the mandate names another strategy than the agent's rule ${agent.rule} (${agent.ruleSha256.slice(0, 12)}…)`, 422);
  const cfg = agent.config as { policy?: string; quoteSizeUsd?: unknown; minHalfSpreadBps?: unknown };
  const mismatch = (what: string): never => { throw new UserError('quoting_config_mismatch', `${what}. The section must say what the agent's configuration (version ${agent.configVersion}) says: change the configuration first, then create the mandate.`, 422); };
  if ((cfg.policy ?? 'spread_inventory') !== body.engine.policy) mismatch(`the agent runs the policy ${String(cfg.policy ?? 'spread_inventory')}, the section says ${body.engine.policy}`);
  if (Number(cfg.quoteSizeUsd) !== Number(body.engine.quoteSizeUsd)) mismatch(`the agent quotes ${String(cfg.quoteSizeUsd)} USD, the section says ${body.engine.quoteSizeUsd}`);
  if (!(Number(cfg.minHalfSpreadBps) >= body.terms.minHalfSpreadBps)) mismatch(`the agent's minimum half-spread (${String(cfg.minHalfSpreadBps)} bps) is below the mandate's minimum distance from the signer's mid (${body.terms.minHalfSpreadBps} bps): the signer would refuse its quotes`);
  const section: QuotingSection = { v: 1, mandateId: mandate.mandateId, tradingMandateHash: mandateHash, terms: body.terms, engine: { ...body.engine, configSha256: agent.configSha256 } };
  try { validateQuotingSection(section, mandate, mandateHash); } catch (e) { asUser(e); }
  return section;
}

export interface CompiledQuoting { mandate: VenueQuotingMandate; enforcement: FieldEnforcement[]; termsEnforcement: TermEnforcement[]; sectionEnforcement: SectionEnforcement[]; derived: { field: string; value: string; from: string }[]; table: string; maxima: Record<string, string> }
/** trading mandate + section → the signer's quoting mandate and the whole enforced-by table (shown verbatim at approval) */
export function compileQuoting(mandate: TradingMandate, section: QuotingSection, binding: { authorization: VenueAuthorization; ackSha256: string }): CompiledQuoting {
  try {
    const c = compileToQuotingMandate(mandate, binding, section.terms), sectionEnforcement = quotingSectionEnforcement(section);
    return { mandate: c.mandate, enforcement: c.enforcement, termsEnforcement: c.termsEnforcement, sectionEnforcement, derived: c.derived, table: renderQuotingApprovalTable(c, sectionEnforcement), maxima: quotingSectionMaxima(mandate) };
  } catch (e) { return asUser(e); }
}
export const sectionHash = quotingSectionHashHex;

/** the server lock of QUOTING on a network (on top of the two mainnet locks the live engine already applied): creating, preparing and approving need it */
export function quotingNetworkLock(network: string, locks: MmLocks = envMmLocks(process.env)): UserError | null {
  // the agent-execution switch gates the session (start, every quote), not the owner's approval of an authority
  const l = mmOpeningLock(network === 'testnet' ? 'testnet' : 'mainnet', { liveMainnet: locks.liveMainnet, mandateMainnet: locks.mandateMainnet, mmMainnet: locks.mmMainnet, ...(locks.mmTestnet ? { mmTestnet: locks.mmTestnet } : {}) });
  return l ? new UserError(l.code, l.message, 403) : null;
}
