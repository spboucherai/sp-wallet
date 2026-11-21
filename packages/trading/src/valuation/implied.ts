/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/valuation/implied.ts
 * Module           : valuation
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

/**
 * Implied valuation of synthetic instruments on private companies (pre-IPO perps and the like).
 *
 * Four different things are kept apart, because they are routinely confused:
 *  - `syntheticPrice`        the price the contract trades at, in the contract's own unit;
 *  - `contractMarketValue`   what ONE contract is worth in USD: price × the venue's contract multiplier. Per share without a
 *                            multiplier it is the price; quoted in valuation units it needs the venue's contract size, else null;
 *  - `notionalExposure`      the USD exposure of a POSITION (size × contract value);
 *  - `impliedValuation`      the company valuation the price implies — given ONLY when the price unit defines it:
 *                              · `valuation_usd_billions`      valuation = price × 1e9      — ONLY with a `formulaSource`
 *                              · `valuation_scaled {divisor}`  valuation = price × divisor  — ONLY with a `formulaSource`
 *                              · `usd_per_share`               valuation = price × fully diluted shares, ONLY with a SOURCED share count
 *                              · `index_points`, `unknown`     no valuation: `{ impliedValuation: null, reason }`
 *
 * Nothing is estimated in silence: every figure carries its formula and the sources and dates it rests on. A synthetic price
 * is the price of a derivative contract; it is not a price at which the company's shares can be bought or sold.
 *
 * Exact decimal arithmetic. Pure.
 */
import { z } from 'zod';
import { D, type DecStr } from '@spw/derivatives';
import { bpsStr, canon, PosDecSchema, ratioBps, TsMsSchema } from '../dec.ts';

const Source = z.string().min(1).max(300);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PriceUnitSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('usd_per_share') }),
  z.strictObject({ kind: z.literal('valuation_usd_billions') }),
  /** the price is the valuation divided by `divisor` (e.g. price 350 with divisor 1e9 = a 350 bn valuation) */
  z.strictObject({ kind: z.literal('valuation_scaled'), divisor: PosDecSchema }),
  z.strictObject({ kind: z.literal('index_points') }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type PriceUnit = z.infer<typeof PriceUnitSchema>;

export const ContractDescriptorSchema = z.strictObject({
  venue: z.string().min(1).max(40),
  symbol: z.string().min(1).max(60),
  priceUnit: PriceUnitSchema,
  /** where the venue documents how the price maps to the company (URL), or null when it documents nothing */
  formulaSource: z.url().nullable(),
  /** fully diluted share count, with its date and source; null when none is sourced */
  dilutedShares: z.strictObject({ value: PosDecSchema, asOf: IsoDate, source: Source }).nullable(),
  /**
   * contract size as the VENUE defines it: USD of notional per contract for 1.00 of price (a linear contract of one unit = 1),
   * with where the venue states it. Optional; absent or null = the venue's contract size is not known to the caller.
   */
  multiplier: z.strictObject({ value: PosDecSchema, source: Source }).nullable().optional(),
});
export type ContractDescriptor = z.infer<typeof ContractDescriptorSchema>;

export const PricePointSchema = z.strictObject({ price: PosDecSchema, ts: TsMsSchema, source: Source });
export type PricePoint = z.infer<typeof PricePointSchema>;

export const PrivateValuationSchema = z.strictObject({
  /** USD */
  value: PosDecSchema,
  /** what kind of figure this is: they are not comparable with each other without care */
  kind: z.enum(['priced_round_post_money', 'priced_round_pre_money', 'tender_offer', 'secondary_market', 'company_statement', 'press_report', 'other']),
  date: IsoDate,
  source: Source,
});
export type PrivateValuation = z.infer<typeof PrivateValuationSchema>;

export const PositionInputSchema = z.strictObject({ side: z.enum(['long', 'short']), /** number of contracts, positive */ size: PosDecSchema });
export type PositionInput = z.infer<typeof PositionInputSchema>;

export interface Sourced { value: DecStr; formula: string; sources: { what: string; source: string; asOf: string }[] }
export type ImpliedValuation = { impliedValuation: Sourced; reason: null } | { impliedValuation: null; reason: string };
export interface ValuationResult {
  venue: string; symbol: string;
  /** the contract's price in its own unit, as traded */
  syntheticPrice: { value: DecStr; unit: PriceUnit['kind']; ts: number; source: string };
  /** USD value of one contract, or null when the unit does not give one */
  contractMarketValue: { value: DecStr | null; reason: string | null; formula: string | null };
  /** USD exposure of the position (signed: negative = short), or null */
  notionalExposure: { value: DecStr | null; reason: string | null; formula: string | null } | null;
  implied: ImpliedValuation;
  /** the implied valuation against the last known private valuation, when both exist */
  versusPrivate: { premiumBps: DecStr | null; reason: string | null; reference: PrivateValuation; caveat: string } | null;
  caveats: string[];
}

const BILLION = D.from(1_000_000_000n);
const isoDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export const VALUATION_CAVEATS = [
  'a synthetic price is the price of a derivative contract: it gives no claim on shares and can trade far from any share transaction',
  'an implied valuation is arithmetic on that price, not an appraisal of the company',
] as const;

/**
 * `position` is optional. `lastPrivate` is the last known private valuation to compare with (premium > 0 = the contract implies
 * more than that figure).
 */
export function impliedValuation(contractIn: ContractDescriptor, priceIn: PricePoint, o: { position?: PositionInput; lastPrivate?: PrivateValuation } = {}): ValuationResult {
  const c = ContractDescriptorSchema.parse(contractIn), p = PricePointSchema.parse(priceIn);
  const position = o.position === undefined ? null : PositionInputSchema.parse(o.position), last = o.lastPrivate === undefined ? null : PrivateValuationSchema.parse(o.lastPrivate);
  const price = D.from(p.price), unit = c.priceUnit;
  const priceSrc = { what: 'contract price', source: p.source, asOf: new Date(p.ts).toISOString() };
  const formulaSrc = [{ what: 'price definition of the venue', source: c.formulaSource ?? 'NOT SOURCED: the descriptor gives no document for the price unit', asOf: 'as published' }];


  // value of one contract in USD
  const mult = c.multiplier ?? null;
  const cmv: ValuationResult['contractMarketValue'] = mult !== null
    // the venue defines the contract size: the USD value of one contract follows whatever the price is a price OF
    ? { value: D.str(D.mul(price, D.from(mult.value))), reason: null, formula: `contract value = price × ${canon(mult.value)} (contract size defined by the venue: ${mult.source})` }
    : unit.kind === 'usd_per_share' ? { value: canon(p.price), reason: null, formula: 'one contract = one synthetic share: value = price (USD)' }
    : unit.kind === 'unknown' ? { value: null, reason: 'the price unit of the contract is unknown and no contract size of the venue was supplied', formula: null }
    : unit.kind === 'index_points' ? { value: null, reason: 'the contract is quoted in index points: the USD value of a point is not defined by the descriptor', formula: null }
    : { value: null, reason: 'the price is a company valuation, not the USD value of a contract: the descriptor does not give a contract multiplier', formula: null };

  const exposure: ValuationResult['notionalExposure'] = position === null ? null
    : cmv.value === null ? { value: null, reason: cmv.reason, formula: null }
    : { value: D.str(D.mul(D.mul(D.from(position.size), D.from(cmv.value)), position.side === 'long' ? D.one : D.neg(D.one))), reason: null, formula: 'size × contract value, negative for a short' };

  let implied: ImpliedValuation;
  if ((unit.kind === 'valuation_usd_billions' || unit.kind === 'valuation_scaled') && c.formulaSource === null) {
    // a unit that no document of the venue backs is a convention, not a definition: nothing is derived from it
    implied = { impliedValuation: null, reason: 'the valuation unit of this contract is not backed by a document of the venue (formulaSource is null): no valuation is derived from an unsourced unit' };
  } else if (unit.kind === 'valuation_usd_billions') {
    implied = { impliedValuation: { value: D.str(D.mul(price, BILLION)), formula: 'valuation = price × 1 000 000 000 (the contract is quoted in USD billions of valuation)', sources: [priceSrc, ...formulaSrc] }, reason: null };
  } else if (unit.kind === 'valuation_scaled') {
    implied = { impliedValuation: { value: D.str(D.mul(price, D.from(unit.divisor))), formula: `valuation = price × ${canon(unit.divisor)} (the contract is quoted as valuation ÷ ${canon(unit.divisor)})`, sources: [priceSrc, ...formulaSrc] }, reason: null };
  } else if (unit.kind === 'usd_per_share') {
    implied = c.dilutedShares === null ? { impliedValuation: null, reason: 'the contract is quoted per share and no sourced fully diluted share count was supplied: a valuation would be a guess' }
      : { impliedValuation: { value: D.str(D.mul(price, D.from(c.dilutedShares.value))), formula: `valuation = price × fully diluted shares (${canon(c.dilutedShares.value)})`,
        sources: [priceSrc, { what: 'fully diluted share count', source: c.dilutedShares.source, asOf: c.dilutedShares.asOf }, ...formulaSrc] }, reason: null };
  } else if (unit.kind === 'index_points') implied = { impliedValuation: null, reason: 'the contract is quoted in index points: no company valuation is defined by its price' };
  else implied = { impliedValuation: null, reason: 'the price unit of the contract is unknown: no valuation is derived' };

  let versus: ValuationResult['versusPrivate'] = null;
  if (last !== null) {
    const caveat = `the reference is a ${last.kind.replace(/_/g, ' ')} dated ${last.date}; the contract price is dated ${isoDay(p.ts)}. The two figures are of different kinds and dates`;
    versus = implied.impliedValuation === null ? { premiumBps: null, reason: implied.reason, reference: last, caveat }
      : { premiumBps: bpsStr(ratioBps(D.sub(D.from(implied.impliedValuation.value), D.from(last.value)), D.from(last.value))), reason: null, reference: last, caveat };
  }
  return { venue: c.venue, symbol: c.symbol, syntheticPrice: { value: canon(p.price), unit: unit.kind, ts: p.ts, source: p.source }, contractMarketValue: cmv, notionalExposure: exposure, implied, versusPrivate: versus,
    caveats: [...VALUATION_CAVEATS, ...(c.dilutedShares !== null && unit.kind === 'usd_per_share' ? [`the share count is dated ${c.dilutedShares.asOf}: later issuances, option pools and conversions change it`] : [])] };
}
