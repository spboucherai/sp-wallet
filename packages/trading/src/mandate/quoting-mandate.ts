/**
 * Trading mandate → QUOTING mandate `SPW-VENUE-QUOTING-MANDATE-v1` (market making on Hyperliquid), with the same honesty rule
 * as `compileToVenueMandate`: one enforcement entry per field of the trading mandate — signer-enforced, partly, or API-only —
 * and no field silently dropped, narrowed or widened (a value that cannot be expressed is a `TradingMandateError`).
 *
 * A trading mandate has no field for what is specific to quoting (how close to the mid, how many quotes may rest, the dead
 * man's switch, the batch rate). Those are the `QuotingTerms`, chosen by the owner next to the mandate; each is enforced by the
 * signer as approved and is listed in `termsEnforcement`. Design: docs/V11-MARKET-MAKING.md.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { D, type DecStr } from '@spw/derivatives';
import { canonicalEncode, hex, QUOTING_MANDATE_BOUNDS, VenueQuotingMandateSchema, type VenueAuthorization, type VenueQuotingMandate } from '@spw/derivatives/live';
import { BREAKER_CODES, type BreakerAction, type BreakerCode } from '../mm/breakers.ts';
import { TRADING_MANDATE_FIELDS, TradingMandateError, TradingMandateSchema, type Enforcement, type FieldEnforcement, type TradingMandate, type TradingMandateErrorCode } from './trading-mandate.ts';

export interface QuotingTerms {
  /** quotes that may rest per side of each instrument */
  levelsPerSide: number;
  /** a quote is never signed closer than this to the signer's own mid, nor further than `maxDistanceBps` */
  minHalfSpreadBps: number; maxDistanceBps: number;
  /** token bucket of quote batches at the signer */
  burstActions: number; actionsPerMinute: number;
  /** quotes signed per UTC hour and per UTC day, and their summed notional per day (USD). The trading mandate's own `frequency`
   *  (at most 500 orders a day) cannot express a quoting rate: these are approved separately, and bounded by compiled ceilings */
  quotesPerHour: number; quotesPerDay: number; dailyTurnoverUsd: DecStr;
  /** the venue's dead man's switch must be armed, at most this far ahead */
  deadManSeconds: number;
}
export const QUOTING_TERMS_FIELDS = ['levelsPerSide', 'minHalfSpreadBps', 'maxDistanceBps', 'burstActions', 'actionsPerMinute', 'quotesPerHour', 'quotesPerDay', 'dailyTurnoverUsd', 'deadManSeconds'] as const;
export interface TermEnforcement { term: (typeof QUOTING_TERMS_FIELDS)[number]; enforcedBy: Enforcement; signerField: string; note: string }
export interface CompiledQuotingMandate { shape: 'SPW-VENUE-QUOTING-MANDATE-v1'; mandate: VenueQuotingMandate; enforcement: FieldEnforcement[]; termsEnforcement: TermEnforcement[]; derived: { field: string; value: string; from: string }[] }

const B = QUOTING_MANDATE_BOUNDS;
const canon = (x: DecStr): DecStr => D.str(D.from(x));
const gt = (a: DecStr, b: DecStr): boolean => D.gt(D.from(a), D.from(b));
function fail(code: TradingMandateErrorCode, message: string, field: keyof TradingMandate | null = null): never { throw new TradingMandateError(code, message, field); }
const intIn = (value: number, min: number, max: number, field: keyof TradingMandate | null, what: string): number => {
  if (!Number.isInteger(value) || value < min || value > max) fail('value_not_expressible', `${what} = ${value} is outside what the signer accepts (${min}…${max})`, field);
  return value;
};
const capped = (value: DecStr, max: DecStr, field: keyof TradingMandate | null, what: string): DecStr => {
  if (gt(value, max)) fail('value_not_expressible', `${what} ${canon(value)} is above the compiled ceiling of a quoting mandate (${max})`, field);
  return canon(value);
};

export function compileToQuotingMandate(m: TradingMandate, binding: { authorization: VenueAuthorization; ackSha256: string }, terms: QuotingTerms): CompiledQuotingMandate {
  const venue = 'hyperliquid', a = binding.authorization;
  const p = TradingMandateSchema.safeParse(m);
  if (!p.success) fail('invalid_mandate', `${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim());
  if (m.mode !== 'live') fail('paper_mandate_has_no_signer_form', 'a paper mandate is never sent to the signer: nothing is signed in paper mode', 'mode');
  if (!m.venues.includes(venue)) fail('venue_not_in_mandate', `${venue} is not a venue of the mandate`, 'venues');
  if (!m.marketKinds.includes('perp')) fail('market_kind_not_expressible', 'a quoting mandate covers perpetuals only, which the mandate does not allow', 'marketKinds');
  if (!m.orderTypes.includes('limit')) fail('value_not_expressible', 'a quoting mandate signs limit orders only (post-only quotes, reduce-only limits), which the mandate does not allow', 'orderTypes');
  if (a.venue !== venue) fail('binding_mismatch', 'the authorization is for another venue', 'venues');
  const accounts = m.accounts.filter((x) => x.kind === 'venue_account' && x.venue === venue);
  if (accounts.length === 0) fail('account_not_in_mandate', `the mandate names no account on ${venue}`, 'accounts');
  if (accounts.length > 1) fail('ambiguous_account', `a quoting mandate covers one account; the mandate names ${accounts.length} on ${venue}`, 'accounts');
  const account = accounts[0]!;
  if (account.kind !== 'venue_account' || account.account.toLowerCase() !== a.account || account.network !== a.network) fail('binding_mismatch', 'the mandate\'s account is not the authorization\'s account and network', 'accounts');
  const instruments = m.instruments.filter((i) => i.slice(0, i.indexOf(':')) === venue);
  if (instruments.length === 0) fail('instrument_not_expressible', `the mandate lists no instrument on ${venue}`, 'instruments');
  if (instruments.length > B.maxInstruments) fail('instrument_not_expressible', `a quoting mandate lists at most ${B.maxInstruments} instruments`, 'instruments');
  for (const i of instruments) {
    if (!/^hyperliquid:[A-Za-z0-9]{1,15}$/.test(i)) fail('instrument_not_expressible', `${i} is not an instrument id the signer accepts`, 'instruments');
    if (!a.policy.allowedInstruments.includes(i)) fail('exceeds_authorization', `${i} is not allowed by the venue authorization`, 'instruments');
  }
  const lev = D.from(m.maxLeverage);
  if (!D.isMultiple(lev, D.one)) fail('value_not_expressible', `the venue takes integer leverage; ${m.maxLeverage} cannot be expressed`, 'maxLeverage');
  const maxLeverage = intIn(Number(D.str(lev)), 1, Math.min(B.maxLeverage, a.policy.maxLeverage), 'maxLeverage', 'leverage');
  if (m.strategySha256 === null) fail('strategy_hash_required', 'the quoting mandate records the strategy the owner approved; this mandate names none', 'strategySha256');
  if (m.notAfter - m.createdAt > B.maxDays * 86400) fail('duration_not_expressible', `a quoting mandate lasts at most ${B.maxDays} days`, 'notAfter');
  if (m.notAfter > a.expiresAt) fail('exceeds_authorization', 'the mandate would outlive the venue authorization', 'notAfter');
  if (!D.isPos(D.from(m.floorEquityUsd))) fail('value_not_expressible', 'the signer needs a positive floor on the account value', 'floorEquityUsd');

  const levels = intIn(terms.levelsPerSide, 1, B.maxRestingPerSide, null, 'quotes per side');
  const total = intIn(levels * 2 * instruments.length, 1, B.maxRestingTotal, null, 'resting quotes in total');
  const quote = capped(m.maxOrderNotionalUsd, B.maxQuoteNotional, 'maxOrderNotionalUsd', 'quote size');
  const inventory = capped(m.maxPositionNotionalUsd, B.maxInventoryNotional, 'maxPositionNotionalUsd', 'inventory limit');
  const restingSide = capped(D.str(D.mul(D.from(m.maxOrderNotionalUsd), D.from(BigInt(levels)))), B.maxRestingNotionalPerSide, 'maxOrderNotionalUsd', 'resting notional per side (quote size × quotes per side)');
  const gross = capped(D.str(D.mul(D.from(m.maxCapitalUsd), lev)), B.maxGrossExposure, 'maxCapitalUsd', 'capital × leverage (gross exposure)');
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(terms.dailyTurnoverUsd) || !D.isPos(D.from(terms.dailyTurnoverUsd))) fail('value_not_expressible', 'the daily turnover must be a positive decimal', null);
  const turnover = capped(terms.dailyTurnoverUsd, B.maxDailyTurnover, null, 'daily turnover');
  for (const [mine, theirs, field, what] of [[quote, a.policy.maxOrderNotional, 'maxOrderNotionalUsd', 'quote size'], [inventory, a.policy.maxPositionNotional, 'maxPositionNotionalUsd', 'inventory limit'], [gross, a.policy.maxGrossExposure, 'maxCapitalUsd', 'capital × leverage (gross exposure)']] as const)
    if (gt(mine, theirs)) fail('exceeds_authorization', `${what} ${mine} is above the venue authorization's ${canon(theirs)}`, field);
  if (terms.maxDistanceBps > a.policy.maxPriceDeviationBps) fail('exceeds_authorization', `quote band wider than the venue authorization's ${a.policy.maxPriceDeviationBps} bps`, null);
  if (m.maxSlippageBps > a.policy.maxPriceDeviationBps) fail('exceeds_authorization', `reduce band wider than the venue authorization's ${a.policy.maxPriceDeviationBps} bps`, 'maxSlippageBps');

  const mandate = VenueQuotingMandateSchema.safeParse({
    v: 1, mandateId: m.mandateId, authorizationId: a.authorizationId, keyId: a.keyId, venue, network: a.network, account: a.account, agentAddress: a.agentAddress,
    strategySha256: m.strategySha256!, agentId: m.principal.id,
    instruments: instruments.map((instrument) => ({ instrument, maxLeverage, maxQuoteNotional: quote, maxRestingPerSide: levels, maxRestingNotionalPerSide: restingSide, maxInventoryNotional: inventory })),
    maxRestingTotal: total, maxGrossExposure: gross,
    minHalfSpreadBps: intIn(terms.minHalfSpreadBps, B.minHalfSpreadBpsFloor, terms.maxDistanceBps - 1, null, 'minimum distance from the mid (bps)'),
    maxDistanceBps: intIn(terms.maxDistanceBps, B.minHalfSpreadBpsFloor + 1, B.maxDistanceBpsCeiling, null, 'maximum distance from the mid (bps)'),
    maxReduceDeviationBps: intIn(m.maxSlippageBps, B.minReduceDeviationBps, B.maxReduceDeviationBps, 'maxSlippageBps', 'reduce band (bps)'),
    floorEquity: canon(m.floorEquityUsd),
    rate: { burstActions: intIn(terms.burstActions, 1, B.maxBurstActions, null, 'burst of quote batches'), actionsPerMinute: intIn(terms.actionsPerMinute, 1, B.maxActionsPerMinute, null, 'quote batches per minute'),
      ordersPerHour: intIn(terms.quotesPerHour, 1, Math.min(B.maxOrdersPerHour, terms.quotesPerDay), null, 'quotes per hour'), ordersPerDay: intIn(terms.quotesPerDay, 1, B.maxOrdersPerDay, null, 'quotes per day'), dailyTurnover: turnover },
    deadManSeconds: intIn(terms.deadManSeconds, B.minDeadManSeconds, B.maxDeadManSeconds, null, 'dead man\'s switch (seconds)'),
    createdAt: m.createdAt, expiresAt: m.notAfter, ackSha256: binding.ackSha256,
  } satisfies VenueQuotingMandate);
  if (!mandate.success) return fail('value_not_expressible', `the quoting mandate is not valid: ${mandate.error.issues[0]?.path.join('.') ?? ''} ${mandate.error.issues[0]?.message ?? ''}`.trim());

  const others = m.venues.filter((v) => v !== venue), otherAccounts = m.accounts.length - 1, lateStart = m.notBefore > m.createdAt;
  const rows: Partial<Record<keyof TradingMandate, [Enforcement, string | null, string]>> = {
    v: ['not_applicable', null, 'version of the trading mandate; the signer shape has its own'],
    mandateId: ['signer', 'mandateId', 'the quoting mandate carries the same id'],
    principal: ['signer_partial', 'agentId', 'recorded by the signer for the audit trail; the signer cannot verify who calls it — the API binds the principal to the mandate'],
    accounts: ['signer', 'account, agentAddress, authorizationId', `the signer signs for this one venue account only, and no directional mandate can be active on it at the same time${otherAccounts > 0 ? `; the mandate's ${otherAccounts} other account(s) are outside this shape` : ''}`],
    venues: ['signer', 'venue', `the shape is for hyperliquid only${others.length ? `; ${others.join(', ')} are outside this shape` : ''}`],
    networks: ['signer', 'network', 'the venue network of the authorization'],
    instruments: ['signer', 'instruments[].instrument', 'the signer refuses any other instrument, and only the pinned ones (BTC, ETH, SOL) can be approved'],
    marketKinds: ['signer', null, 'structural: this shape signs perpetual orders only'],
    orderTypes: ['signer', null, 'narrower than the mandate, structurally: the signer signs post-only (Alo) limit quotes, reduce-only limit orders, cancels and the dead man\'s switch — never a market, stop or take-profit order, whatever the mandate lists'],
    maxCapitalUsd: ['signer_partial', 'maxGrossExposure', 'enforced as worst-case gross exposure ≤ capital × leverage; the capital itself (collateral on the venue) is not capped by the signer'],
    maxOrderNotionalUsd: ['signer', 'instruments[].maxQuoteNotional, maxRestingNotionalPerSide', 'size × max(price, the signer\'s mid) of each quote and of each reduce-only order; quote size × quotes per side bounds what rests on a side'],
    maxPositionNotionalUsd: ['signer', 'instruments[].maxInventoryNotional', 'worst case per instrument — the position plus EVERY resting and pending quote of one side — from the signer\'s own read of the venue account and its own prices'],
    maxLeverage: ['signer', 'instruments[].maxLeverage', 'the signer refuses a quote while the venue\'s leverage setting is higher; a quoting mandate never changes the leverage (the owner sets it, with the passkey)'],
    maxDailyLossUsd: ['api_only', null, 'the signer has no daily-loss limit; it only knows the floor. The engine\'s drawdown breaker is API-side'],
    floorEquityUsd: ['signer', 'floorEquity', 'below the floor the signer signs reduce-only orders, cancels and the dead man\'s switch only (the venue\'s own account value)'],
    createdAt: ['signer', 'createdAt', 'must be current at approval'],
    notBefore: [lateStart ? 'api_only' : 'signer', lateStart ? null : 'createdAt', lateStart ? 'the signer shape has no start time: it would sign from the approval on; the start is enforced by the API' : 'the mandate starts at its creation'],
    notAfter: ['signer', 'expiresAt', `at most ${B.maxDays} days; after it the signer signs only cancels, reduce-only orders and the dead man's switch for 24 h, then nothing`],
    frequency: ['api_only', null, 'NOT carried by this shape: a trading mandate allows at most 500 orders a day, which cannot express a quoting rate. Quotes are metered by the signer from the quoting terms (batches per minute, quotes per hour and per day, daily turnover); the mandate\'s own frequency is applied by the API to the orders that are not quotes'],
    maxSlippageBps: ['signer_partial', 'maxReduceDeviationBps', 'the price band of a reduce-only order around the signer\'s own mid; a quote has its own band (terms); realised slippage is checked by the API'],
    maxFeeUsd: ['api_only', null, 'the signer does not see venue fees'],
    stopConditions: ['api_only', null, 'declarative conditions and every circuit breaker of the engine are API-only; the signer stops on the floor, the expiry, a revocation, its own halt and a missing dead man\'s switch'],
    mode: ['signer', 'network', 'a live mandate; the venue network (mainnet / testnet) is the authorization\'s'],
    strategySha256: ['signer_partial', 'strategySha256', 'recorded by the signer for the audit trail; the signer cannot verify what code runs'],
    label: ['api_only', null, 'a display name; not part of the signer shape'],
  };
  const enforcement = TRADING_MANDATE_FIELDS.map((field): FieldEnforcement => {
    const r = rows[field];
    if (!r) throw new Error(`enforcement of ${field} is not stated`);                              // a field can never be left out of the report
    return { field, enforcedBy: r[0], signerField: r[1], note: r[2] };
  });
  const termsEnforcement: TermEnforcement[] = [
    { term: 'levelsPerSide', enforcedBy: 'signer', signerField: 'instruments[].maxRestingPerSide, maxRestingTotal', note: 'orders that rest or can still land, per side and in total, counted from the signer\'s own read of the venue plus what it signed' },
    { term: 'minHalfSpreadBps', enforcedBy: 'signer', signerField: 'minHalfSpreadBps', note: 'a bid is below, an ask above the signer\'s own mid (two exchanges, fail closed) by at least this: no quote is ever signed at or through it' },
    { term: 'maxDistanceBps', enforcedBy: 'signer', signerField: 'maxDistanceBps', note: 'no quote further than this from the signer\'s own mid' },
    { term: 'burstActions', enforcedBy: 'signer', signerField: 'rate.burstActions', note: 'capacity of the token bucket of quote batches, kept in the signer\'s state file (a restart refills nothing)' },
    { term: 'actionsPerMinute', enforcedBy: 'signer', signerField: 'rate.actionsPerMinute', note: 'refill of that bucket' },
    { term: 'quotesPerHour', enforcedBy: 'signer', signerField: 'rate.ordersPerHour', note: 'quotes signed per UTC hour (orders, not batches); cancels and reduce-only orders are never metered' },
    { term: 'quotesPerDay', enforcedBy: 'signer', signerField: 'rate.ordersPerDay', note: 'quotes signed per UTC day' },
    { term: 'dailyTurnoverUsd', enforcedBy: 'signer', signerField: 'rate.dailyTurnover', note: 'summed notional of the quotes signed per UTC day — signed, not filled: a quote that is requoted counts each time' },
    { term: 'deadManSeconds', enforcedBy: 'signer_partial', signerField: 'deadManSeconds', note: 'the signer signs a quote only after it signed a scheduleCancel that fires after the quote can no longer be accepted, at most this far ahead; it cannot verify that the venue received it' },
  ];
  return { shape: 'SPW-VENUE-QUOTING-MANDATE-v1', mandate: mandate.data, enforcement, termsEnforcement,
    derived: [
      { field: 'maxGrossExposure', value: gross, from: 'maxCapitalUsd × maxLeverage' },
      { field: 'instruments[].maxRestingNotionalPerSide', value: restingSide, from: 'maxOrderNotionalUsd × levelsPerSide' },
      { field: 'maxRestingTotal', value: String(total), from: 'levelsPerSide × 2 × instruments' },
      { field: 'instruments[].maxLeverage', value: String(maxLeverage), from: 'maxLeverage (the same for every instrument)' },
      { field: 'maxReduceDeviationBps', value: String(m.maxSlippageBps), from: 'maxSlippageBps' },
    ] };
}

/** the enforced-by table of a quoting mandate, as Markdown (docs/V11-MARKET-MAKING.md, docs/v11/work/mm-core.md) */
export function renderQuotingEnforcementTable(c: Pick<CompiledQuotingMandate, 'enforcement' | 'termsEnforcement'>): string {
  const label: Record<Enforcement, string> = { signer: 'signer', signer_partial: 'signer (partly)', api_only: 'API only', not_applicable: 'n/a' };
  const cell = (by: Enforcement, field: string | null, note: string) => `**${label[by]}**${field ? ` — \`${field}\`` : ''}. ${note}`;
  return ['| Field | Quoting mandate `SPW-VENUE-QUOTING-MANDATE-v1` |', '|---|---|',
    ...c.enforcement.map((x) => `| \`${x.field}\` | ${cell(x.enforcedBy, x.signerField, x.note)} |`),
    ...c.termsEnforcement.map((x) => `| terms: \`${x.term}\` | ${cell(x.enforcedBy, x.signerField, x.note)} |`)].join('\n');
}

// ------------------------------------------------------------------------------------------------------------------ the quoting section
//
// `SPW-QUOTING-SECTION-v1`: everything the owner chooses for a market-making session that the trading mandate
// (`SPW-TRADING-MANDATE-v1`) has no field for — a SIBLING record of the trading mandate, bound to it by its hash, and covered by
// the same passkey-bound approval intent (services/api/src/mandates/service.ts: the intent names the trading mandate hash, THIS
// record's hash and the hash of the signer's quoting mandate). It is a sibling and not a new field of the trading mandate so
// that the canonical bytes of `SPW-TRADING-MANDATE-v1` — pinned by tests, mirrored by two SDKs — do not move.
//
//   terms    the quote rates and the quote geometry (`QuotingTerms`): compiled ONE TO ONE into the signer's quoting mandate
//            (`compileToQuotingMandate`), enforced by the signer. This is where the quote rate lives: the trading mandate's
//            own `frequency` caps at 500 orders a day and applies to the orders that are not quotes (the reduce-only unwinds).
//   engine   what only the API enforces: the policy and its configuration (by hash), the quote size, the engine's soft and
//            hard inventory limits, the session's hours and maximum duration, the loss limit of a session, what each circuit
//            breaker does, and whether a stop flattens. Stated as API-only in the enforced-by table, never as more.
//
// Every value is checked against a compiled bound and against the mandate it belongs to; an out-of-bounds value is REFUSED
// (`TradingMandateError('value_not_expressible')`), never clamped.

export const QUOTING_SECTION_DOMAIN = 'SPW-QUOTING-SECTION-v1';
export const QUOTING_POLICIES = ['spread_inventory', 'avellaneda_stoikov'] as const;
export type QuotingPolicyId = (typeof QUOTING_POLICIES)[number];
/** compiled bounds of the API-only part (the signer-enforced part is bounded by QUOTING_MANDATE_BOUNDS) */
export const QUOTING_SECTION_BOUNDS = {
  /** the venue refuses an order under 10 USD */
  minQuoteSizeUsd: '10',
  minSessionMinutes: 5, maxSessionMinutes: 1440,
  /** a session loss limit is mandatory and at most this (USD) */
  maxSessionLossUsd: '5000',
  /** the engine stops quoting this long before the mandate expires, at least */
  minStopBeforeExpiryS: 60, maxStopBeforeExpiryS: 86_400,
} as const;
const Sha64 = z.string().regex(/^[0-9a-f]{64}$/);
const DecSchema = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/);
const BreakerActionSchema = z.enum(['pull', 'flatten', 'halt']);
export const QuotingTermsSchema = z.strictObject({
  levelsPerSide: z.number().int(), minHalfSpreadBps: z.number().int(), maxDistanceBps: z.number().int(), burstActions: z.number().int(), actionsPerMinute: z.number().int(),
  quotesPerHour: z.number().int(), quotesPerDay: z.number().int(), dailyTurnoverUsd: DecSchema, deadManSeconds: z.number().int(),
});
export const QuotingSectionSchema = z.strictObject({
  v: z.literal(1),
  mandateId: z.uuid(),
  /** the trading mandate this section belongs to, by its canonical hash */
  tradingMandateHash: Sha64,
  terms: QuotingTermsSchema,
  engine: z.strictObject({
    policy: z.enum(QUOTING_POLICIES),
    /** SHA-256 of the canonical JSON of the agent's rule configuration the owner saw: the engine refuses to quote on another */
    configSha256: Sha64,
    quoteSizeUsd: DecSchema,
    /** |inventory| (USD at the mid) at which the increasing side stops being quoted, and at which everything is pulled and unwound */
    softInventoryUsd: DecSchema, hardInventoryUsd: DecSchema,
    /** a session never lasts longer; null hours = any time. Hours are minutes of the UTC day, [start, end); start > end wraps midnight */
    maxSessionMinutes: z.number().int(), hours: z.strictObject({ startUtcMinute: z.number().int().min(0).max(1439), endUtcMinute: z.number().int().min(0).max(1439) }).nullable(),
    /** positive amount: the session halts when its PnL is below −this */
    maxSessionLossUsd: DecSchema,
    stopBeforeExpiryS: z.number().int(),
    /** what each circuit breaker does; a code that is not listed keeps the compiled default */
    breakers: z.partialRecord(z.enum(BREAKER_CODES), BreakerActionSchema),
    flattenOnStop: z.boolean(),
  }),
});
export type QuotingSection = z.infer<typeof QuotingSectionSchema>;

const sortedBreakers = (b: Partial<Record<BreakerCode, BreakerAction>>): string => (Object.keys(b) as BreakerCode[]).sort().map((k) => `${k}=${b[k]}`).join(',');
/** deterministic, length-prefixed, domain-separated serialization (the encoding of every other canonical object of the wallet) */
export function quotingSectionBytes(q: QuotingSection): Uint8Array {
  const x = QuotingSectionSchema.parse(q), t = x.terms, e = x.engine;
  return canonicalEncode(QUOTING_SECTION_DOMAIN, [
    ['v', '1'], ['mandateId', x.mandateId], ['tradingMandateHash', x.tradingMandateHash],
    ['terms.levelsPerSide', String(t.levelsPerSide)], ['terms.minHalfSpreadBps', String(t.minHalfSpreadBps)], ['terms.maxDistanceBps', String(t.maxDistanceBps)], ['terms.burstActions', String(t.burstActions)],
    ['terms.actionsPerMinute', String(t.actionsPerMinute)], ['terms.quotesPerHour', String(t.quotesPerHour)], ['terms.quotesPerDay', String(t.quotesPerDay)], ['terms.dailyTurnoverUsd', canon(t.dailyTurnoverUsd)],
    ['terms.deadManSeconds', String(t.deadManSeconds)],
    ['engine.policy', e.policy], ['engine.configSha256', e.configSha256], ['engine.quoteSizeUsd', canon(e.quoteSizeUsd)], ['engine.softInventoryUsd', canon(e.softInventoryUsd)], ['engine.hardInventoryUsd', canon(e.hardInventoryUsd)],
    ['engine.maxSessionMinutes', String(e.maxSessionMinutes)], ['engine.hours', e.hours ? `${e.hours.startUtcMinute}-${e.hours.endUtcMinute}` : ''], ['engine.maxSessionLossUsd', canon(e.maxSessionLossUsd)],
    ['engine.stopBeforeExpiryS', String(e.stopBeforeExpiryS)], ['engine.breakers', sortedBreakers(e.breakers)], ['engine.flattenOnStop', e.flattenOnStop ? '1' : '0'],
  ]);
}
export const quotingSectionHashHex = (q: QuotingSection): string => hex(sha256(quotingSectionBytes(q)));

/** the maximum the owner may choose for each value of the section, given the mandate it belongs to — shown next to every field of the form */
export function quotingSectionMaxima(m: Pick<TradingMandate, 'maxOrderNotionalUsd' | 'maxPositionNotionalUsd' | 'instruments'>): Record<string, string> {
  const n = Math.max(1, m.instruments.length), S = QUOTING_SECTION_BOUNDS;
  return {
    'terms.levelsPerSide': String(Math.min(B.maxRestingPerSide, Math.floor(B.maxRestingTotal / (2 * n)))), 'terms.minHalfSpreadBps': `≥ ${B.minHalfSpreadBpsFloor}`, 'terms.maxDistanceBps': String(B.maxDistanceBpsCeiling),
    'terms.burstActions': String(B.maxBurstActions), 'terms.actionsPerMinute': String(B.maxActionsPerMinute), 'terms.quotesPerHour': String(B.maxOrdersPerHour), 'terms.quotesPerDay': String(B.maxOrdersPerDay),
    'terms.dailyTurnoverUsd': B.maxDailyTurnover, 'terms.deadManSeconds': `${B.minDeadManSeconds}…${B.maxDeadManSeconds}`,
    'engine.quoteSizeUsd': `${S.minQuoteSizeUsd}…${D.str(D.min(D.from(m.maxOrderNotionalUsd), D.from(B.maxQuoteNotional)))}`,
    'engine.hardInventoryUsd': D.str(D.min(D.from(m.maxPositionNotionalUsd), D.from(B.maxInventoryNotional))), 'engine.softInventoryUsd': '< hardInventoryUsd',
    'engine.maxSessionMinutes': `${S.minSessionMinutes}…${S.maxSessionMinutes}`, 'engine.maxSessionLossUsd': S.maxSessionLossUsd, 'engine.stopBeforeExpiryS': `${S.minStopBeforeExpiryS}…${S.maxStopBeforeExpiryS}`,
    maxDays: String(B.maxDays), maxInstruments: String(B.maxInstruments), maxLeverage: String(B.maxLeverage), maxQuoteNotional: B.maxQuoteNotional, maxInventoryNotional: B.maxInventoryNotional, maxGrossExposure: B.maxGrossExposure,
  };
}

/**
 * Is the section a valid companion of this trading mandate? Throws `TradingMandateError` naming the value (in the message;
 * `field` is the trading-mandate field it is bounded by, when there is one). The terms themselves are bounded again by
 * `compileToQuotingMandate` against the signer's compiled ceilings and the venue authorization.
 */
export function validateQuotingSection(q: QuotingSection, m: TradingMandate, tradingMandateHash: string): void {
  const p = QuotingSectionSchema.safeParse(q);
  if (!p.success) fail('value_not_expressible', `quoting section: ${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim());
  if (q.mandateId !== m.mandateId || q.tradingMandateHash !== tradingMandateHash) fail('binding_mismatch', 'the quoting section is for another trading mandate (id or hash)');
  if (m.principal.kind !== 'agent') fail('principal_not_expressible', 'a quoting mandate is approved for a market-making AGENT, never for an API key', 'principal');
  const e = q.engine, S = QUOTING_SECTION_BOUNDS, pos = (x: DecStr): boolean => D.isPos(D.from(x));
  if (!pos(e.quoteSizeUsd) || D.lt(D.from(e.quoteSizeUsd), D.from(S.minQuoteSizeUsd))) fail('value_not_expressible', `engine.quoteSizeUsd ${e.quoteSizeUsd} is under the venue's minimum order value (${S.minQuoteSizeUsd} USD)`);
  if (gt(e.quoteSizeUsd, m.maxOrderNotionalUsd)) fail('value_not_expressible', `engine.quoteSizeUsd ${e.quoteSizeUsd} is above the mandate's maxOrderNotionalUsd (${canon(m.maxOrderNotionalUsd)})`, 'maxOrderNotionalUsd');
  if (!pos(e.softInventoryUsd) || !pos(e.hardInventoryUsd) || !gt(e.hardInventoryUsd, e.softInventoryUsd)) fail('value_not_expressible', 'engine.softInventoryUsd must be positive and below engine.hardInventoryUsd');
  if (gt(e.hardInventoryUsd, m.maxPositionNotionalUsd)) fail('value_not_expressible', `engine.hardInventoryUsd ${e.hardInventoryUsd} is above the mandate's maxPositionNotionalUsd (${canon(m.maxPositionNotionalUsd)})`, 'maxPositionNotionalUsd');
  // what can rest on one side on top of the hard limit must still fit the signer's worst-case inventory bound
  const worst = D.add(D.from(e.hardInventoryUsd), D.mul(D.from(e.quoteSizeUsd), D.from(BigInt(Math.max(1, q.terms.levelsPerSide)))));
  if (D.gt(worst, D.from(m.maxPositionNotionalUsd))) fail('value_not_expressible', `engine.hardInventoryUsd + quoteSizeUsd × levelsPerSide (${D.str(worst)}) is above the mandate's maxPositionNotionalUsd (${canon(m.maxPositionNotionalUsd)}): the signer would refuse the quotes that reach the engine's own limit`, 'maxPositionNotionalUsd');
  intIn(e.maxSessionMinutes, S.minSessionMinutes, S.maxSessionMinutes, null, 'engine.maxSessionMinutes');
  intIn(e.stopBeforeExpiryS, S.minStopBeforeExpiryS, S.maxStopBeforeExpiryS, null, 'engine.stopBeforeExpiryS');
  if (e.hours && e.hours.startUtcMinute === e.hours.endUtcMinute) fail('value_not_expressible', 'engine.hours: an empty window (start = end); use null for any time');
  if (!pos(e.maxSessionLossUsd) || gt(e.maxSessionLossUsd, S.maxSessionLossUsd)) fail('value_not_expressible', `engine.maxSessionLossUsd ${e.maxSessionLossUsd} must be positive and at most ${S.maxSessionLossUsd}`);
  if (gt(e.maxSessionLossUsd, m.maxDailyLossUsd)) fail('value_not_expressible', `engine.maxSessionLossUsd ${e.maxSessionLossUsd} is above the mandate's maxDailyLossUsd (${canon(m.maxDailyLossUsd)})`, 'maxDailyLossUsd');
  // a breaker that stops the session by construction cannot be softened to a plain pull
  for (const c of ['consecutive_rejects', 'drawdown_session', 'drawdown_day'] as const) if (e.breakers[c] === 'pull') fail('value_not_expressible', `engine.breakers.${c}: this breaker always stops the session (halt, or flatten then halt); "pull" is not accepted`);
}

export interface SectionEnforcement { field: string; enforcedBy: Enforcement; note: string }
/** the API-only rows of the enforced-by table: said as they are */
export function quotingSectionEnforcement(q: QuotingSection): SectionEnforcement[] {
  const api = (field: string, note: string): SectionEnforcement => ({ field, enforcedBy: 'api_only', note });
  return [
    api('engine.policy', `the quoting rule the engine runs (${q.engine.policy}); the signer cannot verify what code runs — it bounds every quote whatever the rule asks`),
    api('engine.configSha256', 'the rule configuration the owner saw; the engine refuses to quote when the agent\'s configuration has another hash'),
    api('engine.quoteSizeUsd', 'the size the engine quotes; the signer bounds it from above (maxQuoteNotional)'),
    api('engine.softInventoryUsd', 'the engine stops quoting the increasing side; the signer knows only the worst-case inventory bound'),
    api('engine.hardInventoryUsd', 'the engine pulls every quote and unwinds reduce-only to the soft limit; the signer knows only the worst-case inventory bound'),
    api('engine.maxSessionMinutes', 'the engine stops the session; the signer knows only the mandate\'s expiry'),
    api('engine.hours', 'the engine quotes inside these UTC hours only; the signer would sign at any hour'),
    api('engine.maxSessionLossUsd', 'the engine\'s session drawdown breaker; the signer knows only the floor on the account value'),
    api('engine.stopBeforeExpiryS', 'the engine stops quoting this long before the expiry; at the expiry itself the signer refuses every quote'),
    api('engine.breakers', 'every circuit breaker and what it does (pull, flatten, halt) is API-side; the signer knows none of them'),
    api('engine.flattenOnStop', 'whether a stop unwinds the inventory reduce-only; the signer signs reduce-only orders at any time'),
  ];
}
/** the whole enforced-by table of a quoting mandate, as Markdown — what the approval sheet shows verbatim */
export function renderQuotingApprovalTable(c: Pick<CompiledQuotingMandate, 'enforcement' | 'termsEnforcement'>, section: SectionEnforcement[]): string {
  const label: Record<Enforcement, string> = { signer: 'signer', signer_partial: 'signer (partly)', api_only: 'API only', not_applicable: 'n/a' };
  return [renderQuotingEnforcementTable(c), ...section.map((x) => `| section: \`${x.field}\` | **${label[x.enforcedBy]}**. ${x.note} |`)].join('\n');
}
