/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/perp-live-world.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// The world of a LIVE perp agent for tests and for scripts/sim-perp-agent-live.mts: the REAL live execution engine, the REAL
// isolated signer class with its REAL venue reader (in process, a public test mnemonic or a throwaway one), a software passkey
// producing real WebAuthn assertions, and the scripted fake of the Hyperliquid exchange + info endpoints (hl-fake.ts — the one
// derivatives-mandate.test.ts uses). No network: a request to any real host fails. Import AFTER the database environment is set
// (`useDatabase`), because it loads the API's source lazily.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer, SignerError } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { hyperliquidReader } from '../../isolated-signer/src/venue-read.ts';
import { Clock } from './derivatives-helpers.ts';
import { FakeHl, routeFetch } from './hl-fake.ts';

export const RP = 'wallet.test', ORIGIN = 'https://wallet.test', BTC = 'hyperliquid:BTC';
export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** the venue authorization of the tests: BTC, 3×, 1 000 per order and position, 1 500 gross */
export const AUTH_POLICY = { allowedInstruments: [BTC], maxLeverage: 3, maxOrderNotional: '1000', maxPositionNotional: '1000', maxGrossExposure: '1500', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 };

/**
 * `real`: instead of the fake, the venue is reached through this fetch (scripts/sim-perp-agent-live.mts --testnet passes one
 * that only lets the Hyperliquid TESTNET through) and the clock is the wall clock; the fakes then stay unused.
 */
export async function liveWorld(o: { mnemonic?: string; start?: number; real?: { fetch: typeof fetch } } = {}) {
  const lv = await import('../src/derivatives/live.ts'), ex = await import('../src/derivatives/exec.ts'), { UserError } = await import('../src/config.ts');
  const keys = deriveKeys(o.mnemonic ?? TEST_MNEMONIC), ACCOUNT = keys.addresses.evm.toLowerCase();
  const clock = new Clock(o.start ?? Date.parse('2026-11-11T12:00:00Z'));
  if (o.real) { clock.now = () => Date.now(); clock.advance = () => Date.now(); }
  const t = new FakeHl('testnet', clock.now), m = new FakeHl('mainnet', clock.now);
  const dir = mkdtempSync(join(tmpdir(), 'spw-perp-live-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  /** the signer's OWN prices (it never takes one from the API) */
  const px: { BTC: number; fail: string } = { BTC: 70_000, fail: '' };
  /** an info request type the venue fails on (502): for the API, or for the signer's own reader */
  const faults: { info: string | null; signerInfo: string | null } = { info: null, signerInfo: null };
  const base = o.real?.fetch ?? routeFetch([t, m]);
  const failing = (which: 'info' | 'signerInfo') => (async (url: string, init?: RequestInit) => {
    const type = JSON.parse(String(init?.body ?? '{}')).type;
    if (String(url).endsWith('/info') && faults[which] === type) return new Response('bad gateway', { status: 502 });
    return base(url as never, init);
  }) as unknown as typeof fetch;
  const reader = hyperliquidReader(async (url, body) => {
    const r = await failing('signerInfo')(url, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(clock.now() / 1000),
    { get: async (s) => { if (px.fail) throw new Error(px.fail); return Object.fromEntries(s.map((k) => [k, (px as unknown as Record<string, number>)[k]!])); } }, reader);
  const pk = new TestPasskey(RP, ORIGIN);
  const call = async <T>(fn: () => T | Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof SignerError) throw new UserError(`signer_${e.code}`, e.message, 422); throw e; } };
  /** every request that reached the signer's mandate signing endpoint (orders carry `context.order`, leverage changes do not) */
  const mandateSigns: any[] = [], signs: unknown[] = [];
  const port: import('../src/derivatives/exec.ts').LiveSignerPort = {
    status: () => call(() => signer.status()), venueKey: (v, n) => call(() => signer.venueKey(v, n)),
    venueAuthorize: (a, s) => call(() => signer.venueAuthorize(a, s as never)), venueRevoke: (id) => call(() => signer.venueRevoke(id)),
    venueSign: (p) => { signs.push(p); return call(() => signer.venueSign(p as never)); },
  };
  const mandatePort: import('../src/derivatives/exec.ts').MandateSignerPort = {
    venueMandateApprove: (x, s) => call(() => signer.venueMandateApprove(x, s as never)), venueMandateRevoke: (id) => call(() => signer.venueMandateRevoke(id)),
    venueMandateSign: (p) => { mandateSigns.push(p); return call(() => signer.venueMandateSign(p as never)); },
  };
  const flags = { mainnet: false, mandateMainnet: false };
  const svc = lv.createLive({ fetch: failing('info'), signer: port, mandateSigner: mandatePort, now: clock.now, rpId: RP, mainnetEnabled: () => flags.mainnet, mandateMainnetEnabled: () => flags.mandateMainnet,
    credentials: async () => [{ id: pk.id, transports: ['internal'] }], confirmDelayMs: 0 });
  const b64 = (hexHash: string) => Buffer.from(hexHash, 'hex');
  /** the owner's part in Futures → Accounts: a venue account, funded on the fake venue, authorised with the passkey */
  const authorise = async (network: 'testnet' | 'mainnet' = 'testnet', fund: string | null = '1000', policy: Record<string, unknown> = AUTH_POLICY, days = 30): Promise<string> => {
    if (signer.status().credentials.length === 0) await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
    if (fund !== null) (network === 'testnet' ? t : m).fund(ACCOUNT, fund);
    const id = (await svc.createAccount({ venue: 'hyperliquid', network, label: network === 'testnet' ? 'Testnet' : 'Mainnet' })).id as string;
    const prep = await svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy, days, locale: 'fr' }));
    await svc.approveAuthorization(id, { assertion: pk.assert(b64(prep.hash)) as never, acknowledged: true });
    return id;
  };
  return { clock, t, m, signer, store, pk, px, flags, faults, signs, mandateSigns, svc, ACCOUNT, b64, authorise, port, mandatePort,
    /** requests to the signer's mandate endpoint for ORDERS (not leverage changes) */
    orderSigns: () => mandateSigns.filter((s) => s.context?.order).length,
    /** a minute later: past the signer's ledger of the last order, and a fresh minute of the adapter's local rate budget */
    next: (ms = 61_000) => clock.advance(ms) };
}
export type LiveWorld = Awaited<ReturnType<typeof liveWorld>>;
