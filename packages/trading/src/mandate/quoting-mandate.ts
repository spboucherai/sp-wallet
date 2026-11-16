/**
 * Trading mandate → QUOTING mandate `SPW-VENUE-QUOTING-MANDATE-v1` (market making on Hyperliquid), with the same honesty rule
 * as `compileToVenueMandate`: one enforcement entry per field of the trading mandate — signer-enforced, partly, or API-only —
 * and no field silently dropped, narrowed or widened (a value that cannot be expressed is a `TradingMandateError`).
 *
 * A trading mandate has no field for what is specific to quoting (how close to the mid, how many quotes may rest, the dead
 * man's switch, the batch rate). Those are the `QuotingTerms`, chosen by the owner next to the mandate; each is enforced by the
 * signer as approved and is listed in `termsEnforcement`. Design: docs/V11-MARKET-MAKING.md.
 */
import { D, type DecStr } from '@spw/derivatives';
import { QUOTING_MANDATE_BOUNDS, VenueQuotingMandateSchema, type VenueAuthorization, type VenueQuotingMandate } from '@spw/derivatives/live';
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
