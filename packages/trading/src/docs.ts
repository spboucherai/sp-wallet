/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/docs.ts
 * Module           : trading
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
 * Blocks of the documentation that are GENERATED from the code, so that the documents cannot drift from it.
 * A block lives in a Markdown file between `<!-- GENERATED:<name> -->` and `<!-- /GENERATED:<name> -->`.
 * test/docs.test.ts compares every block with what the code renders now; `UPDATE_DOCS=1 pnpm vitest run packages/trading/test/docs.test.ts`
 * rewrites them. Pure: this module only builds strings.
 */
import type { Mandate } from '@spw/core';
import type { VenueAuthorization } from '@spw/derivatives/live';
import { CLIENT_ORDER_ID_FORMATS } from './orders/idempotency.ts';
import { CANCEL_REASONS, FAILURE_REASONS, PROGRESS_REASONS, REJECT_REASONS, renderTransitionTable, UNKNOWN_REASONS } from './orders/state.ts';
import { renderVocabularyTables } from './orders/vocabulary.ts';
import { renderRiskChecks } from './risk/engine.ts';
import { compileToSpotMandate, compileToVenueMandate, renderEnforcementTable, type SpotMandateBinding, type TradingMandate } from './mandate/trading-mandate.ts';
import { KEYWORDS } from './commands/parse.ts';

/** a reference mandate and its bindings: the smallest live mandate that compiles to both signer shapes (also used by the tests) */
export const REFERENCE_MANDATE: TradingMandate = {
  v: 1, mandateId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f601', principal: { kind: 'agent', id: 'agent-reference' },
  accounts: [
    { kind: 'venue_account', venue: 'hyperliquid', network: 'mainnet', account: '0x1111111111111111111111111111111111111111' },
    { kind: 'vault', vaultIndex: 1, address: '0x2222222222222222222222222222222222222222', network: 'base' },
  ],
  venues: ['hyperliquid', 'kyberswap'], networks: ['mainnet', 'base'], instruments: ['hyperliquid:BTC', 'hyperliquid:ETH', 'kyberswap:WETH-USDC'], marketKinds: ['perp', 'spot'], orderTypes: ['market', 'limit'],
  maxCapitalUsd: '5000', maxOrderNotionalUsd: '1000', maxPositionNotionalUsd: '4000', maxLeverage: '3', maxDailyLossUsd: '250', floorEquityUsd: '4000',
  createdAt: 1_800_000_000, notBefore: 1_800_000_000, notAfter: 1_800_000_000 + 14 * 86400, frequency: { perMinute: 2, perHour: 20, perDay: 100 }, maxSlippageBps: 50, maxFeeUsd: '5',
  stopConditions: [{ kind: 'loss_gte', usd: '750' }, { kind: 'drawdown_gte', bps: 1500 }, { kind: 'consecutive_rejects_gte', count: 5 }, { kind: 'data_stale_gte', ms: 30_000 }, { kind: 'signer_unreachable_gte', ms: 60_000 }],
  mode: 'live', strategySha256: 'a'.repeat(64), label: 'Reference mandate',
};
export const REFERENCE_AUTHORIZATION: VenueAuthorization = {
  v: 1, authorizationId: '0b9c8d7e-6f50-4a41-9b32-c1d0e9f8a702', keyId: 'owner-key-0001', venue: 'hyperliquid', network: 'mainnet', account: '0x1111111111111111111111111111111111111111',
  agentAddress: '0x3333333333333333333333333333333333333333', agentName: 'spw', mode: 'MANUAL_LIVE',
  policy: { allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL'], maxLeverage: 5, maxOrderNotional: '2000', maxPositionNotional: '8000', maxGrossExposure: '20000', maxOrdersPerDay: 200, maxPriceDeviationBps: 300 },
  createdAt: 1_799_990_000, expiresAt: 1_799_990_000 + 60 * 86400, approveNonce: 1_799_990_000_000, ackSha256: 'b'.repeat(64),
};
export const REFERENCE_SPOT_BINDING: SpotMandateBinding = {
  keyId: 'owner-key-0001', provider: 'kyberswap',
  assets: [{ id: '0x4200000000000000000000000000000000000006', decimals: 18, priceUsd: '2500', sellable: true }, { id: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, priceUsd: '1', sellable: true }],
  instrumentAssets: { 'kyberswap:WETH-USDC': ['0x4200000000000000000000000000000000000006', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'] },
};

function reasonCodes(): string {
  const row = (title: string, to: string, xs: readonly string[]) => `| ${title} | ${to} | ${xs.map((x) => `\`${x}\``).join(', ')} |`;
  return ['| Group | State it leads to | Codes |', '|---|---|---|', row('progress', '(any non-terminal, or FILLED)', PROGRESS_REASONS), row('refusal', '`REJECTED`', REJECT_REASONS), row('technical failure', '`FAILED`', FAILURE_REASONS),
    row('withdrawal / expiry / cancellation', '`CANCELLED`', CANCEL_REASONS), row('outcome not known', '`UNKNOWN`', UNKNOWN_REASONS)].join('\n');
}
function clientIdFormats(): string {
  return ['| Venue | Bits kept | Form |', '|---|---|---|', ...Object.keys(CLIENT_ORDER_ID_FORMATS).map((v) => `| \`${v}\` | ${CLIENT_ORDER_ID_FORMATS[v]!.bits} | ${CLIENT_ORDER_ID_FORMATS[v]!.note} |`)].join('\n');
}
function keywords(): string {
  return ['| Keyword | Accepted spellings (case-insensitive, accents ignored) |', '|---|---|', ...(Object.keys(KEYWORDS) as (keyof typeof KEYWORDS)[]).map((k) => `| \`${k}\` | ${KEYWORDS[k].map((w) => `\`${w}\``).join(', ')} |`)].join('\n');
}
function enforcement(): string {
  const venue = compileToVenueMandate(REFERENCE_MANDATE, { authorization: REFERENCE_AUTHORIZATION, ackSha256: REFERENCE_AUTHORIZATION.ackSha256 });
  const spot: { enforcement: ReturnType<typeof compileToSpotMandate>['enforcement']; mandate: Mandate } = compileToSpotMandate(REFERENCE_MANDATE, REFERENCE_SPOT_BINDING);
  return renderEnforcementTable(venue.enforcement, spot.enforcement);
}

/** file (relative to the repository root) → block name → content */
export function generatedDocBlocks(): Record<string, Record<string, string>> {
  return {
    'docs/V11-EXECUTION-ENGINE.md': { 'transition-table': renderTransitionTable(), 'reason-codes': reasonCodes(), 'vocabularies': renderVocabularyTables(), 'client-id-formats': clientIdFormats(), 'command-keywords': keywords() },
    'docs/V11-RISK-MODEL.md': { 'risk-checks': renderRiskChecks() },
    'docs/TRADING-MANDATES.md': { 'enforced-by': enforcement() },
  };
}

const open = (name: string) => `<!-- GENERATED:${name} -->`, close = (name: string) => `<!-- /GENERATED:${name} -->`;
/** the content of a block in a document, or null when the markers are missing */
export function readDocBlock(doc: string, name: string): string | null {
  const a = doc.indexOf(open(name)), b = doc.indexOf(close(name));
  return a < 0 || b < a ? null : doc.slice(a + open(name).length, b).replace(/^\n/, '').replace(/\n$/, '');
}
/** the document with the block replaced; throws when the markers are missing */
export function writeDocBlock(doc: string, name: string, content: string): string {
  const a = doc.indexOf(open(name)), b = doc.indexOf(close(name));
  if (a < 0 || b < a) throw new Error(`the document has no GENERATED:${name} block`);
  return `${doc.slice(0, a)}${open(name)}\n${content}\n${doc.slice(b)}`;
}
