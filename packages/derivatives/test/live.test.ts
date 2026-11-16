// Controlled live trading — the shared, pure part (`@spw/derivatives/live`): canonical objects and their hashes, the pinned
// Hyperliquid asset table against the recorded venue meta, the acknowledgement text, and the leanness of the entry point that
// is bundled into the isolated signer.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HL_PINNED_ASSETS, hex, hlPinnedAsset, hlPinnedMismatch, JURISDICTION_ACK, jurisdictionAck, jurisdictionAckOf, validateVenueAuthorization, venueAgentWireName, venueAuthorizationHash, VenueAuthorizationSchema,
  venueLeverageHash, venueOrderBytes, venueOrderHash, venueOrderNotional, VenueOrderSchema, VenuePolicySchema, venueWindowError, withinBand,
  type VenueAuthorization, type VenueLeverage, type VenueOrder,
} from '../src/live/index.ts';

const NOW = 1794398400;
const A: VenueAuthorization = { v: 1, authorizationId: '7a1c1f0e-8f5f-4b1e-9c56-000000000001', keyId: 'spw-0123456789abcdef', venue: 'hyperliquid', network: 'testnet', account: `0x${'11'.repeat(20)}`, agentAddress: `0x${'22'.repeat(20)}`,
  agentName: 'spw-live', mode: 'MANUAL_LIVE', policy: { allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxLeverage: 3, maxOrderNotional: '200', maxPositionNotional: '400', maxGrossExposure: '600', maxOrdersPerDay: 20, maxPriceDeviationBps: 300 },
  createdAt: NOW, expiresAt: NOW + 30 * 86400, approveNonce: NOW * 1000, ackSha256: jurisdictionAck('hyperliquid', 'fr').sha256 };
const O: VenueOrder = { v: 1, authorizationId: A.authorizationId, venue: 'hyperliquid', network: 'testnet', account: A.account, kind: 'order', instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.002', price: '69500',
  triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `0x${'ab'.repeat(16)}`, nonce: NOW * 1000 + 123, expiresAt: NOW * 1000 + 90_123 };
const L: VenueLeverage = { v: 1, authorizationId: A.authorizationId, venue: 'hyperliquid', network: 'testnet', account: A.account, kind: 'leverage', instrument: 'hyperliquid:BTC', leverage: 3, marginMode: 'cross', nonce: O.nonce, expiresAt: O.expiresAt };

describe('canonical hashes', () => {
  it('are pinned: a change of the serialization changes these values and must be deliberate', () => {
    expect(hex(venueAuthorizationHash(A))).toBe('cc093bb259776c2fc21f3bcb7031c78586408821cd53dcf66f5e1cbcd4ba008c');
    expect(hex(venueOrderHash(O))).toBe('449b7eb372814fa1c02f78dc7a0fe5c90f6787e7ab1de6aa2208117a959d95db');
    expect(hex(venueLeverageHash(L))).toBe('b1484f9cb6689f9e691242e69147f12402851217edcd9a9bb0e2a2767814164e');
  });

  it('the order hash is SHA-256 of a domain tag and length-prefixed (name, value) pairs in a fixed order — recomputed here by hand', () => {
    const fields: [string, string][] = [['v', '1'], ['authorizationId', O.authorizationId], ['venue', 'hyperliquid'], ['network', 'testnet'], ['account', O.account], ['kind', 'order'], ['instrument', O.instrument], ['side', 'buy'],
      ['type', 'limit'], ['size', '0.002'], ['price', '69500'], ['triggerPrice', ''], ['reduceOnly', '0'], ['tif', 'gtc'], ['clientId', O.clientId], ['nonce', String(O.nonce)], ['expiresAt', String(O.expiresAt)]];
    const parts: Buffer[] = [Buffer.from('SPW-VENUE-ORDER-v1'), Buffer.from([0])];
    for (const [k, v] of fields) { const h = Buffer.alloc(6); h.writeUInt16BE(Buffer.byteLength(k), 0); h.writeUInt32BE(Buffer.byteLength(v), 2); parts.push(h, Buffer.from(k), Buffer.from(v)); }
    expect(Buffer.from(venueOrderBytes(O)).equals(Buffer.concat(parts))).toBe(true);
    expect(hex(venueOrderHash(O))).toBe(createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
  });

  it('every field the approval screen shows changes the order hash', () => {
    const base = hex(venueOrderHash(O));
    const changes: Partial<VenueOrder>[] = [{ instrument: 'hyperliquid:ETH' }, { side: 'sell' }, { size: '0.0021' }, { price: '69501' }, { triggerPrice: '69000', type: 'stop_limit' }, { type: 'stop_market', triggerPrice: '69500' }, { reduceOnly: true },
      { tif: 'ioc' }, { clientId: `0x${'ac'.repeat(16)}` }, { nonce: O.nonce + 1 }, { expiresAt: O.expiresAt + 1 }, { network: 'mainnet' }, { account: `0x${'33'.repeat(20)}` }, { authorizationId: '7a1c1f0e-8f5f-4b1e-9c56-000000000002' }];
    const seen = new Set([base]);
    for (const c of changes) { const h = hex(venueOrderHash({ ...O, ...c })); expect(seen.has(h), JSON.stringify(c)).toBe(false); seen.add(h); }
    // decimals are hashed in canonical form: the same number written differently is the same order
    expect(hex(venueOrderHash({ ...O, size: '0.0020', price: '69500.0' }))).toBe(base);
    expect(() => venueOrderHash({ ...O, extra: 1 } as never)).toThrow();
    expect(() => venueOrderHash({ ...O, size: '-1' })).toThrow();
    expect(() => venueOrderHash({ ...O, clientId: 'my-order' })).toThrow();
    expect(VenueOrderSchema.safeParse({ ...O, type: 'market' }).success).toBe(false);                 // a market order is shown as what it is on the venue: limit + ioc
  });

  it('every field of the authorization changes its hash; instrument order does not', () => {
    const base = hex(venueAuthorizationHash(A));
    const changes: Partial<VenueAuthorization>[] = [{ network: 'mainnet' }, { account: `0x${'33'.repeat(20)}` }, { agentAddress: `0x${'44'.repeat(20)}` }, { agentName: 'other' }, { mode: 'MANDATE_LIVE' }, { createdAt: NOW + 1 }, { expiresAt: A.expiresAt + 1 },
      { approveNonce: A.approveNonce + 1 }, { ackSha256: jurisdictionAck('hyperliquid', 'en').sha256 }, { keyId: 'spw-ffffffffffffffff' }, { authorizationId: '7a1c1f0e-8f5f-4b1e-9c56-000000000002' }];
    const policies: Partial<VenueAuthorization['policy']>[] = [{ allowedInstruments: ['hyperliquid:BTC'] }, { maxLeverage: 4 }, { maxOrderNotional: '201' }, { maxPositionNotional: '401' }, { maxGrossExposure: '601' }, { maxOrdersPerDay: 21 }, { maxPriceDeviationBps: 301 }];
    const seen = new Set([base]);
    for (const c of changes) { const h = hex(venueAuthorizationHash({ ...A, ...c })); expect(seen.has(h), JSON.stringify(c)).toBe(false); seen.add(h); }
    for (const c of policies) { const h = hex(venueAuthorizationHash({ ...A, policy: { ...A.policy, ...c } })); expect(seen.has(h), JSON.stringify(c)).toBe(false); seen.add(h); }
    expect(hex(venueAuthorizationHash({ ...A, policy: { ...A.policy, allowedInstruments: ['hyperliquid:ETH', 'hyperliquid:BTC'], maxOrderNotional: '200.00' } }))).toBe(base);
    expect(hex(venueLeverageHash({ ...L, leverage: 4 }))).not.toBe(hex(venueLeverageHash(L)));
    expect(hex(venueLeverageHash({ ...L, marginMode: 'isolated' }))).not.toBe(hex(venueLeverageHash(L)));
    // the three kinds of object can never be confused: different domains
    expect(new Set([hex(venueAuthorizationHash(A)), hex(venueOrderHash(O)), hex(venueLeverageHash(L))]).size).toBe(3);
  });
});

describe('authorization rules', () => {
  it('MANUAL_LIVE only, at most 90 days, current, limits ordered, bounded policy', () => {
    expect(() => validateVenueAuthorization(A, NOW)).not.toThrow();
    expect(() => validateVenueAuthorization({ ...A, mode: 'MANDATE_LIVE' }, NOW)).toThrow(/always MANUAL_LIVE.*MANDATE_LIVE.*derivative mandate/);
    expect(() => validateVenueAuthorization({ ...A, expiresAt: NOW + 90 * 86400 }, NOW)).not.toThrow();
    expect(() => validateVenueAuthorization({ ...A, expiresAt: NOW + 90 * 86400 + 1 }, NOW)).toThrow(/at most 90 days/);
    expect(() => validateVenueAuthorization(A, A.expiresAt)).toThrow(/expired/);
    expect(() => validateVenueAuthorization(A, NOW + 601)).toThrow(/not current/);
    expect(() => validateVenueAuthorization({ ...A, approveNonce: (NOW + 3600) * 1000 }, NOW)).toThrow(/nonce is not current/);
    expect(() => validateVenueAuthorization({ ...A, agentAddress: A.account }, NOW)).toThrow(/must differ/);
    expect(() => validateVenueAuthorization({ ...A, policy: { ...A.policy, maxPositionNotional: '100' } }, NOW)).toThrow(/order limit above the position limit/);
    expect(() => validateVenueAuthorization({ ...A, policy: { ...A.policy, maxGrossExposure: '300' } }, NOW)).toThrow(/position limit above the gross/);
    expect(() => validateVenueAuthorization({ ...A, policy: { ...A.policy, allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:BTC'] } }, NOW)).toThrow(/duplicate/);
    for (const bad of [{ maxLeverage: 21 }, { maxLeverage: 0 }, { maxOrdersPerDay: 501 }, { maxPriceDeviationBps: 9 }, { maxPriceDeviationBps: 2001 }, { allowedInstruments: [] }, { allowedInstruments: ['dydx:BTC-USD'] }, { maxOrderNotional: '0' }, { maxOrderNotional: '1e3' }])
      expect(VenuePolicySchema.safeParse({ ...A.policy, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(VenueAuthorizationSchema.safeParse({ ...A, account: A.account.toUpperCase() }).success).toBe(false);
    expect(venueAgentWireName(A)).toBe(`spw-live valid_until ${A.expiresAt * 1000}`);
  });

  it('order window, notional and price band', () => {
    const now = O.nonce + 1_000;
    expect(venueWindowError(O, now)).toBeNull();
    expect(venueWindowError({ nonce: O.nonce, expiresAt: O.nonce + 120_000 }, now)).toBeNull();
    expect(venueWindowError({ nonce: O.nonce, expiresAt: O.nonce + 120_001 }, now)).toMatch(/longer than 120 s/);
    expect(venueWindowError({ nonce: O.nonce, expiresAt: O.nonce }, now)).toMatch(/not after/);
    expect(venueWindowError(O, O.expiresAt)).toMatch(/expired/);
    expect(venueWindowError({ nonce: now + 60_001, expiresAt: now + 100_000 }, now)).toMatch(/future/);
    expect(venueOrderNotional(O)).toBe('139');
    expect(venueOrderNotional({ size: '0.002', price: '68000', triggerPrice: '69000' })).toBe('138');
    expect(withinBand('70700', '70000', 100)).toBe(true);                                             // exactly 100 bps
    expect(withinBand('70700.1', '70000', 100)).toBe(false);
    expect(withinBand('69300', '70000', 100)).toBe(true);
    expect(withinBand('69299.9', '70000', 100)).toBe(false);
    expect(withinBand('70000', '0', 100)).toBe(false);
  });
});

describe('pinned Hyperliquid asset table', () => {
  const meta = (net: string) => JSON.parse(readFileSync(new URL(`./fixtures/hyperliquid/${net}-meta.json`, import.meta.url), 'utf8')).body.universe as { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean }[];
  it('equals the venue meta recorded on both networks, index for index', () => {
    for (const net of ['mainnet', 'testnet'] as const) {
      const u = meta(net);
      for (const p of HL_PINNED_ASSETS[net]) expect(u[p.asset], `${net} ${p.symbol}`).toMatchObject({ name: p.symbol, szDecimals: p.szDecimals, maxLeverage: p.maxLeverage });
      const table = u.map((x, i) => ({ symbol: x.name, asset: i, szDecimals: x.szDecimals, maxLeverage: x.maxLeverage, isolatedOnly: x.onlyIsolated === true, delisted: x.isDelisted === true }));
      expect(hlPinnedMismatch(net, table)).toBeNull();
      expect(hlPinnedMismatch(net, table.map((a) => (a.symbol === 'BTC' ? { ...a, delisted: true } : a)))).toMatch(/delisted/);
      expect(hlPinnedMismatch(net, table.map((a) => (a.symbol === 'BTC' ? { ...a, maxLeverage: 20 } : a)))).toBeNull();   // a lower venue maximum cannot mislead the signer
    }
    // the two networks number the assets differently: a mainnet payload cannot be read with the testnet table
    expect(hlPinnedAsset('mainnet', 'hyperliquid:BTC')!.asset).not.toBe(hlPinnedAsset('testnet', 'hyperliquid:BTC')!.asset);
    expect(hlPinnedAsset('testnet', 'hyperliquid:DOGE')).toBeNull();
  });
});

describe('jurisdiction acknowledgement', () => {
  it('one constant, two languages, hashes pinned; nothing presents it as a legal clearance', () => {
    const fr = jurisdictionAck('hyperliquid', 'fr'), en = jurisdictionAck('hyperliquid', 'en');
    expect(fr.sha256).toBe('3eb96b500ab80008a04164202e66e40f0ef2cf2d7bd79348f836b98fa548ca98');
    expect(en.sha256).toBe('859fab5d4ecfdb5127e300cb96105ce2fc8e8ebbc80584ad02a2a88ee85ad783');
    expect(fr.sha256).toBe(createHash('sha256').update(JURISDICTION_ACK.hyperliquid.fr, 'utf8').digest('hex'));
    expect(jurisdictionAckOf('hyperliquid', en.sha256)).toMatchObject({ locale: 'en' });
    expect(jurisdictionAckOf('hyperliquid', 'ab'.repeat(32))).toBeNull();
    for (const t of [fr.text, en.text]) {
      expect(t).toMatch(/Ontario/); expect(t).toMatch(/AMF/); expect(t).toMatch(/21-332/); expect(t).toMatch(/§1\.9/);
      // the only sentence about lawfulness says whose responsibility it is to determine it; nothing states that trading is cleared
      expect(t).not.toMatch(/is (legal|permitted|allowed|cleared|compliant) (in|for)|you (may|can|are allowed to) trade|has been (cleared|approved|validated)/i);
      expect(t).not.toMatch(/est (légale?|permise?|autorisée?|conforme) (au|en|pour)|vous (pouvez|êtes autorisé à) négocier|a été (validée?|approuvée?|autorisée?)/i);
    }
    expect(en.text).toMatch(/not legal advice/); expect(en.text).toMatch(/not a legal clearance/); expect(en.text).toMatch(/your own decision/);
    expect(fr.text).toMatch(/pas un avis juridique/); expect(fr.text).toMatch(/pas une validation juridique/); expect(fr.text).toMatch(/votre propre décision/);
    // the facts are those of docs/v4/venues/jurisdiction.md
    const doc = readFileSync(new URL('../../../docs/v4/venues/jurisdiction.md', import.meta.url), 'utf8');
    for (const fact of ['United States of America or Ontario, Canada', '§1.6', '2026-06-15', '§1.9', '21-332', 'checked 2026-11-10']) expect(doc, fact).toContain(fact);
  });
});

describe('the entry point bundled into the isolated signer is lean', () => {
  it('reaches no HTTP client, no websocket stream, no venue read adapter — only pure code', () => {
    const here = dirname(fileURLToPath(import.meta.url)), seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) walk(resolve(dirname(file), m[2]!));
    };
    walk(resolve(here, '../src/live/index.ts'));
    const files = [...seen].map((f) => f.slice(f.indexOf('/src/') + 5)).sort();
    expect(files).toEqual(['decimal.ts', 'live/canonical.ts', 'live/collateral.ts', 'live/gmx.ts' /* v8: GMX pins, calldata builder, venue policy — pure */, 'live/hl-assets.ts', 'live/index.ts', 'live/jurisdiction.ts', 'live/mandate.ts', 'live/quoting.ts' /* V11: the quoting mandate — canonical bytes and bounds, pure */, 'models.ts', 'venue.ts', 'venues/hyperliquid/error.ts', 'venues/hyperliquid/format.ts',
      'venues/hyperliquid/msgpack.ts', 'venues/hyperliquid/schemas.ts', 'venues/hyperliquid/signing.ts', 'venues/hyperliquid/trading.ts']);
    for (const f of seen) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bfetch\(|WebSocket|node:https?|node:net\b/);
  });
});
