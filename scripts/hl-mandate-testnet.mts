// MANDATE_LIVE on the Hyperliquid TESTNET, end to end, with the real pieces: the real API service and its live engine, the real
// isolated signer class behind its real HMAC channel — with its OWN exchange prices (Coinbase + Kraken) and its OWN read of the
// venue account (the testnet's public info endpoint) —, PostgreSQL, a software passkey producing real WebAuthn assertions, and
// the real testnet. Never mainnet: every request to api.hyperliquid.xyz is refused by this script before it leaves the process,
// and both mainnet settings (SPW_DERIV_LIVE_MAINNET, SPW_DERIV_MANDATE_MAINNET) are forced off.
//
// KEYS. The wallet seed is generated IN MEMORY by this script (a fresh BIP-39 phrase), is never printed, never written to disk,
// and is gone when the process ends. No existing key, seed or secrets file is read. The signer's state goes to a temporary
// directory; the database is `spw_hl_mandate_testnet` (dropped and recreated on each run).
//
// ─── HOW TO RUN ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   npx tsx scripts/hl-mandate-testnet.mts                    unfunded run (default): needs nothing, sends nothing of value.
//
//       venue account (READ_ONLY) → authorization (passkey) → the venue answers "Must deposit before performing actions"
//       (its documented answer for an account that never deposited) → the API revokes the authorization, and a mandate
//       cannot even be prepared (`mode_read_only`). The script then drives the signer directly, over the same HMAC channel
//       as the API: authorization → mandate approved with ONE passkey assertion → without any passkey: a leverage change, a
//       reduce-only order and a cancel are signed by the trading key and sent to the testnet, which answers "User or API
//       Wallet 0x<our trading key> does not exist." (it recovered OUR trading key: its hash of the action equals ours); an
//       order that can add exposure is refused by the SIGNER after it read the testnet account itself (account value 0,
//       below the mandate's floor); then the other refusals with real prices; then revoke → wind-down → authorization revoked.
//       `--record` writes the exchanges to packages/derivatives/test/fixtures/hyperliquid/testnet-mandate-proof.json.
//
//   npx tsx scripts/hl-mandate-testnet.mts --wait-funding 900 funded run: the whole flow, for the owner.
//
//       Fund the printed address exactly as for scripts/hl-live-testnet.mts (50 mock USDC, "USDC (Perps)", from a funded
//       testnet account of yours). The script then runs, checking the venue's own state after each step: authorize
//       (passkey) → mandate (ONE passkey) → leverage 3× under the mandate (no passkey) → post-only limit buy 2 % below the
//       mark (no passkey) → `open` → cancel → market buy of about 15 USDC (no passkey) → fill, position → the signer's
//       counters → an order above the position limit, refused by the signer → reduce-only close → revoke the mandate →
//       an order is refused (wind-down), a cancel still passes → revoke the authorization. About 20 mock USDC are enough.
//
//   Options: --size 0.0002 (BTC size of the test orders), --record (unfunded run only).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  createHlTrading, hlPinnedAssets, jurisdictionAck, recoverTypedDataSigner, venueAuthorizationHash, venueMandateHash,
  type HlL1SignPayload, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueMandate, type VenueOrder,
} from '../packages/derivatives/src/live/index.ts';
import { D } from '../packages/derivatives/src/index.ts';
import { HL_API, hlQuantizePrice } from '../packages/derivatives/src/venues/hyperliquid/index.ts';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../services/isolated-signer/src/prices.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';
import { hyperliquidReader, VENUE_INFO_URL } from '../services/isolated-signer/src/venue-read.ts';

const NETWORK = 'testnet' as const, TESTNET = 'https://api.hyperliquid-testnet.xyz';
if (HL_API[NETWORK] !== TESTNET || VENUE_INFO_URL.testnet !== `${TESTNET}/info`) throw new Error('refusing to run: not the testnet endpoint');
const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'm'.repeat(48), DB = 'spw_hl_mandate_testnet', BTC = 'hyperliquid:BTC', P = '/api/v1/derivatives/live';
const flag = (name: string) => process.argv.includes(`--${name}`), arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const waitFunding = Number(arg('wait-funding') ?? 0), SIZE = arg('size') ?? '0.0002';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);
const b64 = (hexHash: string) => Buffer.from(hexHash, 'hex');
const SHA = createHash('sha256').update('scripts/hl-mandate-testnet.mts — no strategy, a proof').digest('hex'), AGENT_ID = 'testnet-proof';

// ── a guard in front of every outgoing request: nothing may reach Hyperliquid MAINNET from this script ────────────────────
const realFetch = globalThis.fetch, traffic: Record<string, number> = {};
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (u.host === 'api.hyperliquid.xyz') throw new Error(`refusing a request to Hyperliquid MAINNET (${u.pathname}) from the testnet script`);
  const k = `${u.host}${u.host.includes('hyperliquid') ? u.pathname : ''}`;
  traffic[k] = (traffic[k] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;
delete process.env.SPW_DERIV_LIVE_MAINNET; delete process.env.SPW_DERIV_MANDATE_MAINNET;                // both mainnet locks stay closed, whatever the shell says

const keys = deriveKeys(generateMnemonic(wordlist, 128));                                             // throwaway seed, in memory only
const ACCOUNT = keys.addresses.evm.toLowerCase();
let signerSrv: Server | undefined, app: any, sql: any, exit = 0;
const record: { step: string; request?: unknown; status?: number; answer: unknown }[] = [];
const check = (ok: boolean, what: string) => { log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) exit = 1; return ok; };

/** raw POST /exchange on TESTNET, to record the venue's exact words */
async function postExchange(step: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${TESTNET}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = text; }
  record.push({ step, request: body, status: r.status, answer: parsed });
  log(`\n[venue] ${step}\n  HTTP ${r.status}  ${JSON.stringify(parsed)}`);
  await sleep(300);
  return { status: r.status, body: parsed };
}

try {
  execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);
  const dir = mkdtempSync(join(tmpdir(), 'spw-hl-mandate-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('testnet-setup').digest('hex');
  // the signer's OWN prices (Coinbase + Kraken) and its OWN read of the venue account (testnet info endpoint)
  const signerCore = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, exchangePrices(), hyperliquidReader());
  signerSrv = createSignerServer(signerCore, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../services/api/src/db.ts'); sql = db.sql; await db.migrate();
  const { signer } = await import('../services/api/src/signer-client.ts');                            // the API's client of the signer: the real HMAC channel
  const liveMod = await import('../services/api/src/derivatives/live.ts'), mm = await import('../services/api/src/derivatives/mandate.ts');
  if (liveMod.mainnetLiveEnabled() || liveMod.mandateMainnetEnabled()) throw new Error('refusing to run: a mainnet setting is on');
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [] });

  const pk = new TestPasskey(RP, ORIGIN); let cookie = '';
  const api = async (method: 'GET' | 'POST', path: string, body?: unknown, idem?: string) => {
    const r = await app.inject({ method, url: path, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
      ...(method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    return { status: r.statusCode as number, json: (() => { try { return r.json(); } catch { return null; } })() as any, setCookie: r.headers['set-cookie'] as string | undefined };
  };
  const ok = async (method: 'GET' | 'POST', path: string, body?: unknown, idem?: string) => { const r = await api(method, path, body, idem); if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const o = await ok('POST', '/api/v1/auth/setup/options', {});
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: pk.register(o.options.challenge), setupToken: 'testnet-setup' });
  if (s.status !== 200) throw new Error(`setup failed: ${JSON.stringify(s.json)}`);
  cookie = String(s.setCookie).split(';')[0]!;

  log(`Hyperliquid TESTNET mandate flow  ${new Date().toISOString()}`);
  const cfg = await ok('GET', `${P}/config`);
  log(`mainnet settings: live ${cfg.mainnet.enabled ? 'ON (unexpected)' : 'off'}, mandate ${cfg.mandateLive.mainnet.enabled ? 'ON (unexpected)' : 'off'}; mandates available: ${cfg.mandateLive.available}; throwaway wallet ${ACCOUNT} (seed in memory only)`);
  check(cfg.mainnet.enabled === false && cfg.mandateLive.mainnet.enabled === false && cfg.mandateLive.available === true && cfg.modes.includes('MANDATE_LIVE'), 'config: mandates available, both mainnet locks closed');

  // 1 ── keys and the venue account
  const key = await ok('POST', `${P}/venue-key`, { venue: 'hyperliquid', network: 'testnet' });
  const AGENT = key.address as string;
  const acct = await ok('POST', `${P}/accounts`, { venue: 'hyperliquid', network: 'testnet', label: 'HL testnet' });
  const id = acct.id as string;
  log(`\n1. trading key ${AGENT} (path ${key.path}); venue account ${id}: mode ${acct.mode}, modes ${JSON.stringify(acct.modes)}, equity ${acct.venueState.state?.equity} (source: ${acct.venueState.source})`);
  check(acct.mode === 'READ_ONLY' && acct.mandate === null, 'a new venue account is READ_ONLY and has no mandate');
  const mainAcct = await api('POST', `${P}/accounts`, { venue: 'hyperliquid', network: 'mainnet', label: 'HL mainnet' });
  check(mainAcct.status === 403 && mainAcct.json.error === 'mainnet_disabled', `a mainnet venue account is refused while mainnet is off: ${mainAcct.status} ${mainAcct.json.error}`);

  // what the signer itself reads from the venue — recorded, it is the basis of every exposure decision
  const own = await hyperliquidReader().account('testnet', ACCOUNT);
  record.push({ step: 'signer read: clearinghouseState + frontendOpenOrders of the throwaway account (testnet info endpoint)', answer: own });
  log(`   the signer's own read of the testnet account: time ${new Date(own.time).toISOString()}, account value ${own.accountValue}, total position notional ${own.totalNtlPos}, ${own.positions.length} position(s), ${own.openOrders.length} open order(s)`);
  check(Math.abs(Date.now() - own.time) < 30_000, `the venue's timestamp is ${Math.abs(Date.now() - own.time)} ms from this clock (the signer accepts 30 s)`);

  let equity = D.from(acct.venueState.state?.equity ?? '0');
  if (waitFunding > 0 && D.lt(equity, D.from('15'))) {
    log(`\n   WAITING up to ${waitFunding} s for testnet mock USDC on ${ACCOUNT}\n   → send 50 mock USDC (Perps) to that address from a funded testnet account (see the top of scripts/hl-live-testnet.mts).`);
    const until = Date.now() + waitFunding * 1000;
    while (Date.now() < until && D.lt(equity, D.from('15'))) { await sleep(5000); equity = D.from((await ok('GET', `${P}/accounts/${id}`)).venueState.state?.equity ?? '0'); }
    log(`   equity now ${D.str(equity)} USDC`);
  }
  const funded = D.gte(equity, D.from('15'));

  // 2 ── authorization (MANUAL_LIVE): the root a mandate extends
  const POLICY = { allowedInstruments: [BTC], maxLeverage: 3, maxOrderNotional: '60', maxPositionNotional: '120', maxGrossExposure: '180', maxOrdersPerDay: 30, maxPriceDeviationBps: 1000 };
  const LIMITS = { instruments: [{ instrument: BTC, maxLeverage: 3, maxPositionNotional: '40' }], maxOrderNotional: '30', maxGrossExposure: '40', maxOrdersPerDay: 20, maxOrdersPerHour: 20, maxDailyTurnover: '300', floorEquity: '5' };
  const prep = await ok('POST', `${P}/accounts/${id}/authorization/prepare`, { policy: POLICY, days: 2, locale: 'en' });
  const approve = await api('POST', `${P}/accounts/${id}/authorization/approve`, { assertion: pk.assert(b64(prep.hash)), acknowledged: true });
  record.push({ step: 'API authorization/approve (signer signs approveAgent with the wallet key; the API sends it to the testnet)', status: approve.status, answer: approve.status === 200 ? { mode: approve.json.mode } : approve.json });

  const trading = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: 30_000 });
  const venueApi = liveMod.live().deps.venues.get('testnet');
  const inst = await venueApi.instrument(BTC), { ticker } = await venueApi.market(inst);
  await venueApi.assertPinned();
  const px = (factor: string, mode: 'down' | 'up') => hlQuantizePrice(D.str(D.div(D.mul(D.from(ticker.mark), D.from(factor)), D.one, 1, mode)), 5, mode);
  log(`\n   live testnet BTC mark ${ticker.mark}, oracle ${ticker.index}; pinned asset table matches the venue's live meta`);

  if (!funded) {
    // ── UNFUNDED: stop at the venue's documented refusal ─────────────────────────────────────────────────────────────────
    log(`\n2. authorization approve → HTTP ${approve.status} ${approve.json.error}\n   "${approve.json.message}"`);
    check(approve.status === 422 && approve.json.error === 'venue_rejected' && String(approve.json.message).includes(`Must deposit before performing actions. User: ${ACCOUNT}`), 'the venue refused the approveAgent for its documented reason (no deposit); the account stays READ_ONLY');
    const noMandate = await api('POST', `${P}/accounts/${id}/mandate/prepare`, { ...LIMITS, days: 1, locale: 'en', strategySha256: SHA, agentId: AGENT_ID });
    check(noMandate.status === 422 && noMandate.json.error === 'mode_read_only', `a mandate cannot be prepared on a read-only account: ${noMandate.status} ${noMandate.json.error}`);
    const noOrder = await mm.placeMandateOrder(id, { instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price: px('0.98', 'down'), triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: 'x' }, { strategySha256: SHA, agentId: AGENT_ID, clientId: `unfunded-${Date.now()}` })
      .then(() => 'placed', (e: Error & { code?: string }) => `${e.code}`);
    check(noOrder === 'mode_read_only', `placeMandateOrder on it: ${noOrder}`);

    // ── the signer, driven directly (same HMAC channel as the API) ────────────────────────────────────────────────────────
    log('\n3. the signer, driven directly: authorization, then a mandate approved with ONE passkey assertion');
    const st1 = await signer.status(true), nowS = Math.floor(Date.now() / 1000), ack = jurisdictionAck('hyperliquid', 'en').sha256;
    const auth: VenueAuthorization = { v: 1, authorizationId: crypto.randomUUID(), keyId: st1.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-live', mode: 'MANUAL_LIVE',
      policy: POLICY, createdAt: nowS, expiresAt: nowS + 2 * 86400, approveNonce: Date.now(), ackSha256: ack };
    const mandate: VenueMandate = { v: 1, mandateId: crypto.randomUUID(), authorizationId: auth.authorizationId, keyId: st1.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, strategySha256: SHA, agentId: AGENT_ID,
      ...LIMITS, maxPriceDeviationBps: 1000, createdAt: nowS, expiresAt: nowS + 86400, ackSha256: ack };
    const call = <T>(p: Promise<T>) => p.then((r) => ({ ok: true as const, r }), (e: Error & { code?: string }) => ({ ok: false as const, error: `${e.code}: ${e.message}` }));
    const early = await call(signer.venueMandateApprove(mandate, pk.assert(venueMandateHash(mandate))));
    check(!early.ok && /^signer_no_authorization/.test(early.error), `a mandate without its authorization — ${early.ok ? 'ACCEPTED' : early.error.slice(0, 120)}`);
    const granted = await signer.venueAuthorize(auth, pk.assert(venueAuthorizationHash(auth)));
    await postExchange('approveAgent signed by the wallet key (user-signed action)', { action: granted.approve.action, nonce: granted.approve.nonce, signature: granted.approve.signature, vaultAddress: null, expiresAfter: null });
    const noPasskey = await call(signer.venueMandateApprove(mandate, undefined));
    check(!noPasskey.ok && /bad_approval/.test(noPasskey.error), `mandate approval without a passkey assertion — ${noPasskey.ok ? 'ACCEPTED' : noPasskey.error.slice(0, 100)}`);
    const wider = { ...mandate, maxGrossExposure: '181' };
    const tooWide = await call(signer.venueMandateApprove(wider, pk.assert(venueMandateHash(wider))));
    check(!tooWide.ok && /above the authorization's 180/.test(tooWide.error), `a mandate wider than its authorization — ${tooWide.ok ? 'ACCEPTED' : tooWide.error.slice(0, 120)}`);
    const approved = await signer.venueMandateApprove(mandate, pk.assert(venueMandateHash(mandate)));
    check(approved.hash === Buffer.from(venueMandateHash(mandate)).toString('hex'), `mandate ${mandate.mandateId} stored by the signer; hash ${approved.hash.slice(0, 16)}… (limits: order 30, position 40, gross 40, floor 5 USDC, 3×, band 1000 bps)`);

    let nonce = Date.now();
    const next = () => { nonce = Math.max(Date.now(), nonce + 1); return nonce; };
    const canonicalOf = (req: OrderRequest, n: number): VenueOrder => { const x = trading.normalizeRequest(req, inst); return { v: 1, authorizationId: auth.authorizationId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, kind: 'order',
      instrument: x.instrument, side: x.side, type: x.type as VenueOrder['type'], size: x.size, price: x.price!, triggerPrice: x.triggerPrice, reduceOnly: x.reduceOnly, tif: x.tif, clientId: x.clientId, nonce: n, expiresAt: n + 30_000 }; };
    const sign = (p: { sign: SignRequest; context?: unknown }) => signer.venueMandateSign({ mandateId: mandate.mandateId, ...p }).then((r) => ({ ok: true as const, ...r }), (e: Error & { code?: string }) => ({ ok: false as const, error: `${e.code}: ${e.message}` }));
    const names = (answer: unknown, who: string) => JSON.stringify(answer).toLowerCase().includes(who);
    const mk = (o: Partial<OrderRequest>) => { const n = next(), req: OrderRequest = { instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price: px('0.98', 'down'), triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: `mandate-proof-${n}`, ...o };
      const b = trading.buildOrder(req, { instrument: inst, nonce: n }); return { req, n, action: b.action, sign: b.sign, canonical: canonicalOf(req, n) }; };
    const send = async (step: string, b: { action: unknown; n: number }, signature: unknown) => postExchange(step, { action: b.action, nonce: b.n, signature, vaultAddress: null, expiresAfter: b.n + 30_000 });
    const refused = async (what: string, want: RegExp, p: Parameters<typeof sign>[0]) => { const r = await sign(p); check(!r.ok && want.test(r.error), `${what} — ${r.ok ? 'SIGNED (unexpected)' : r.error.slice(0, 170)}`); record.push({ step: `signer: ${what}`, answer: r.ok ? 'signed' : r.error }); };

    log('\n4. /venue/mandate/sign — NO passkey from here on');
    // (a) leverage: the signer reads the venue account itself first (no position → the margin mode may be set)
    const ln = next(), lev = trading.buildUpdateLeverage({ instrument: inst, leverage: 3, marginMode: 'cross', nonce: ln }), ls = await sign({ sign: lev.sign });
    check(ls.ok, `leverage 3× cross — ${ls.ok ? `signed by ${ls.signer} (phase ${ls.phase})` : ls.error}`);
    if (ls.ok) { const r = await send('updateLeverage signed under the mandate (no passkey)', { action: lev.action, n: ln }, ls.signature); check(names(r.body, AGENT) && /does not exist/.test(JSON.stringify(r.body)), 'the venue names OUR trading key: it recovered it from the signature'); }
    const lev4 = trading.buildUpdateLeverage({ instrument: inst, leverage: 4, marginMode: 'cross', nonce: next() });
    await refused('leverage 4× (the mandate says 3×)', /^signer_leverage_exceeded: /, { sign: lev4.sign });
    // (b) an order that can add exposure: the signer reads the testnet account — account value 0 is below the floor
    const inc = mk({});
    await refused(`order buy ${SIZE} BTC @ ${inc.req.price} that can add exposure, on an account the venue values at ${own.accountValue}`, /^signer_floor_equity: the venue reports an account value of 0(\.0+)?, below the mandate's floor of 5/, { sign: inc.sign, context: { order: inc.canonical } });
    // (c) a reduce-only order needs no venue read and no counter: signed, sent, and the venue names our trading key
    const ro = mk({ side: 'sell', reduceOnly: true, tif: 'ioc', price: px('0.99', 'down') }), rs = await sign({ sign: ro.sign, context: { order: ro.canonical } });
    if (check(rs.ok, `reduce-only sell ${SIZE} BTC @ ${ro.req.price} — ${rs.ok ? `signed by ${rs.signer}, no passkey` : rs.error}`) && rs.ok) {
      check(rs.signer === AGENT && await recoverTypedDataSigner((ro.sign.payload as HlL1SignPayload).typedData, rs.signature) === AGENT, 'the signature is the TRADING key\'s (recovered locally)');
      const r = await send('reduce-only order signed under the mandate (no passkey; expiresAfter = nonce + 30 s)', ro, rs.signature);
      check(names(r.body, AGENT) && /does not exist/.test(JSON.stringify(r.body)), 'the venue names OUR trading key: its hash of the action (expiry included) equals ours');
      check(!names(r.body, ACCOUNT), 'the wallet key appears nowhere in the order path');
    }
    // (d) a cancel
    const cn = next(), cancel = trading.buildCancel({ instrument: inst, clientId: ro.req.clientId, nonce: cn }), cs = await sign({ sign: cancel.sign });
    check(cs.ok, `cancel by client id — ${cs.ok ? 'signed' : cs.error}`);
    if (cs.ok) { const r = await send('cancelByCloid signed under the mandate', { action: cancel.action, n: cn }, cs.signature); check(names(r.body, AGENT), 'the venue names our trading key'); }

    log('\n5. signer refusals with its real prices (nothing below is sent to the venue)');
    await refused('reduce-only order at half the market price', /^signer_price: /, { sign: mk({ side: 'sell', reduceOnly: true, tif: 'ioc', price: px('0.5', 'down') }).sign });
    await refused('order above the mandate\'s notional per order (reduce-only included)', /^signer_order_notional: /, { sign: mk({ side: 'sell', reduceOnly: true, size: '0.005' }).sign });
    const eth = { ...inst, symbol: 'ETH', id: 'hyperliquid:ETH', lotSize: '0.0001' }, en = next();
    await refused('order on an instrument outside the mandate', /^signer_instrument: hyperliquid:ETH is not allowed by the mandate/, { sign: trading.buildOrder({ instrument: eth.id, side: 'sell', type: 'limit', size: '0.01', price: '2000', triggerPrice: null, reduceOnly: true, tif: 'gtc', clientId: `eth-${en}` }, { instrument: eth, nonce: en }).sign });
    const lie = mk({ side: 'sell', tif: 'ioc', price: px('0.99', 'down') });
    await refused('the API describes a plain sell as reduce-only', /^signer_mismatch: .*reduce-only/, { sign: lie.sign, context: { order: { ...lie.canonical, reduceOnly: true } } });
    await refused('the same client id again', /^signer_replay: /, { sign: mk({ side: 'sell', reduceOnly: true, tif: 'ioc', price: px('0.99', 'down'), clientId: ro.req.clientId }).sign });
    await refused('an approveAgent for another address smuggled through /venue/mandate/sign', /not an order, a cancel or a leverage change/, { sign: trading.buildApproveAgent({ agentAddress: `0x${'66'.repeat(20)}`, agentName: 'evil', nonce: next() }).sign });
    const long = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: 121_000 }), lo = next();
    await refused('a signature valid for more than 120 s', /^signer_policy: validity window longer than 120 s/, { sign: long.buildOrder({ ...ro.req, clientId: `long-${lo}` }, { instrument: inst, nonce: lo }).sign });

    log('\n6. stopping (no passkey)');
    const stA = (await signer.status(true)).venueMandates!.find((x) => x.mandate.mandateId === mandate.mandateId)!;
    check(stA.phase === 'active' && stA.today.reduceOnly === 1 && stA.today.orders === 0 && stA.today.leverage === 1 && stA.today.cancels === 1, `signer counters today: ${JSON.stringify(stA.today)}`);
    const rv = await signer.venueMandateRevoke(mandate.mandateId);
    check(rv.revoked === true, `mandate revoked at ${rv.revokedAt}; wind-down until ${new Date(rv.windDownUntil * 1000).toISOString()}`);
    await refused('an order that can add exposure during the wind-down', /^signer_wind_down: /, { sign: mk({}).sign });
    await refused('a leverage change during the wind-down', /^signer_wind_down: /, { sign: trading.buildUpdateLeverage({ instrument: inst, leverage: 2, marginMode: 'cross', nonce: next() }).sign });
    const wd = await sign({ sign: mk({ side: 'sell', reduceOnly: true, tif: 'ioc', price: px('0.99', 'down') }).sign });
    check(wd.ok && wd.phase === 'wind_down', `a reduce-only order during the wind-down — ${wd.ok ? `signed (phase ${wd.phase}); not sent` : wd.error}`);
    const wc = await sign({ sign: trading.buildCancel({ instrument: inst, clientId: ro.req.clientId, nonce: next() }).sign });
    check(wc.ok, `a cancel during the wind-down — ${wc.ok ? 'signed; not sent' : wc.error}`);
    await signer.venueRevoke(auth.authorizationId);
    await refused('a reduce-only order after the AUTHORIZATION was revoked', /^signer_revoked: the venue authorization of this mandate was revoked/, { sign: mk({ side: 'sell', reduceOnly: true, tif: 'ioc', price: px('0.99', 'down') }).sign });
    await refused('a cancel after the authorization was revoked', /^signer_revoked: /, { sign: trading.buildCancel({ instrument: inst, clientId: ro.req.clientId, nonce: next() }).sign });
    const stEnd = await signer.status(true);
    check(stEnd.venueMandates!.every((x) => x.phase === 'ended') && stEnd.venues!.every((v) => v.revoked), `signer: ${stEnd.venues!.length} authorization(s) revoked, ${stEnd.venueMandates!.length} mandate(s) ended; journal ${stEnd.journalLength} entries`);

    log('\nUNFUNDED RUN COMPLETE: it stopped where the venue refuses an account that never deposited. To run the funded flow, see the top of this script (--wait-funding).');
    if (flag('record')) {
      writeFileSync(new URL('../packages/derivatives/test/fixtures/hyperliquid/testnet-mandate-proof.json', import.meta.url), `${JSON.stringify({ recordedAt: new Date().toISOString(), network: NETWORK,
        note: 'throwaway seed generated in memory by scripts/hl-mandate-testnet.mts; the account never existed on the venue', account: ACCOUNT, agent: AGENT, mandateId: mandate.mandateId, exchanges: record }, null, 1)}\n`);
      log('recorded → packages/derivatives/test/fixtures/hyperliquid/testnet-mandate-proof.json');
    }
  } else {
    // ── FUNDED: the whole flow through the API and the agent-runtime interface ────────────────────────────────────────────
    if (approve.status !== 200) throw new Error(`authorization approval failed: ${approve.status} ${JSON.stringify(approve.json)}`);
    check(approve.json.mode === 'MANUAL_LIVE', 'authorized: mode MANUAL_LIVE; the venue lists the trading key as an API wallet of the account');
    const who = { strategySha256: SHA, agentId: AGENT_ID }, ctx = (tag: string) => ({ ...who, clientId: `mandate-${tag}-${Date.now()}` });
    const order = (o: Partial<OrderRequest>): OrderRequest => ({ instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price: px('0.98', 'down'), triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: 'ignored', ...o });
    const tryPlace = (o: Partial<OrderRequest>, tag: string) => mm.placeMandateOrder(id, order(o), ctx(tag)).then((r) => ({ ok: true as const, ...r }), (e: Error & { code?: string }) => ({ ok: false as const, error: `${e.code}: ${e.message}` }));

    log('\n3. mandate: prepare (limits, acknowledgement, what the signer enforces) → ONE passkey approval');
    const mp = await ok('POST', `${P}/accounts/${id}/mandate/prepare`, { ...LIMITS, days: 1, locale: 'en', strategySha256: SHA, agentId: AGENT_ID });
    log(`   mandate ${mp.mandate.mandateId}, hash ${mp.hash}\n   ${mp.warning}\n   enforced by the signer: ${mp.enforcedBySigner.length} rules; trusted: ${mp.trustedBySigner.length}; wind-down ${mp.windDown.seconds} s`);
    const ma = await ok('POST', `${P}/accounts/${id}/mandate/approve`, { assertion: pk.assert(b64(mp.hash)), acknowledged: true });
    check(ma.modes.includes('MANDATE_LIVE') && ma.mandate.phase === 'active' && ma.mode === 'MANUAL_LIVE', `modes ${JSON.stringify(ma.modes)}, mandate phase ${ma.mandate.phase}`);

    log('\n4. leverage 3× cross under the mandate (no passkey)');
    const before = await tryPlace({}, 'pre-lev');
    log(`   an order before the leverage is set: ${before.ok ? `state ${before.order.state}` : before.error.slice(0, 140)}`);
    const lv = await mm.setMandateLeverage(id, { instrument: BTC, leverage: 3, marginMode: 'cross' }, who);
    check(lv.venue.confirmed === true, `the venue's own setting is now ${JSON.stringify(lv.venue.leverage)}`);

    log('\n5. post-only limit buy 2 % below the mark (no passkey) → open → cancel');
    await sleep(1000);
    const a = await tryPlace({}, 'limit');
    if (!a.ok) throw new Error(`limit order refused: ${a.error}`);
    check(a.order.state === 'open' && a.order.source === 'venue', `state ${a.order.state} (source ${a.order.source}), venue order id ${a.order.venueOrderId}, venue expiry of the signature ${a.order.expiresAt! - a.order.nonce!} ms`);
    const again = await mm.placeMandateOrder(id, order({}), { ...who, clientId: a.order.clientId });
    check(again.idempotent === true, 'the same client id again places nothing');
    const cr = await mm.cancelMandateOrder(id, a.order.clientId);
    check(cr.order.state === 'cancelled', `cancel: ${JSON.stringify(cr.venue)}, state ${cr.order.state}`);

    log('\n6. market buy (no passkey) → fill → position; then the position limit, enforced by the signer');
    await sleep(1000);
    const m1 = await tryPlace({ type: 'market', tif: 'ioc', price: px('1.01', 'up') }, 'market');
    if (!m1.ok) throw new Error(`market order refused: ${m1.error}`);
    check(['filled', 'partially_filled'].includes(m1.order.state), `market order: ${m1.order.state}, filled ${m1.order.filled} @ ${m1.order.avgFillPrice}`);
    await sleep(1500);
    const s1 = await mm.mandateAccountState(id);
    log(`   venue: equity ${s1.state?.equity}, positions ${JSON.stringify(s1.positions.map((p) => `${p.side} ${p.size} @ ${p.entryPrice}`))}; canOpen ${s1.canOpen}`);
    const sg = (await signer.status(true)).venueMandates!.find((x) => x.mandate.mandateId === mp.mandate.mandateId)!;
    log(`   signer: phase ${sg.phase}, today ${JSON.stringify(sg.today)}, orders last hour ${sg.ordersLastHour}, ledger ${sg.pendingOrders}`);
    const big = await tryPlace({ size: D.str(D.mul(D.from(SIZE), D.from('2'))) }, 'too-much');
    log(`   a second order that would take the worst case above 40 USDC: ${big.ok ? `state ${big.order.state} (the limit was not reached at this price)` : big.error.slice(0, 170)}`);

    log('\n7. reduce-only close, then revoke the mandate (wind-down)');
    const pos = s1.positions.find((p) => p.instrument === BTC);
    if (pos) {
      const c = await tryPlace({ side: 'sell', type: 'market', tif: 'ioc', price: px('0.99', 'down'), size: pos.size, reduceOnly: true }, 'close');
      check(c.ok && ['filled', 'partially_filled'].includes(c.order.state), `close: ${c.ok ? `${c.order.state}, filled ${c.order.filled} @ ${c.order.avgFillPrice}` : c.error}`);
      await sleep(1500);
    }
    const rest = await tryPlace({}, 'rest');
    const rvk = await ok('POST', `${P}/accounts/${id}/mandate/revoke`, { cancelOpenOrders: false });
    check(rvk.mandate.phase === 'wind_down' && !rvk.modes.includes('MANDATE_LIVE'), `mandate revoked: phase ${rvk.mandate.phase}, modes ${JSON.stringify(rvk.modes)}, wind-down until ${new Date(rvk.windDown.until).toISOString()}`);
    const blocked = await tryPlace({}, 'after-revoke');
    check(!blocked.ok && /^mandate_wind_down/.test(blocked.error), `an order that can add exposure after the revocation: ${blocked.ok ? 'PLACED' : blocked.error.slice(0, 120)}`);
    if (rest.ok && rest.order.state === 'open') { const c2 = await mm.cancelMandateOrder(id, rest.order.clientId); check(c2.order.state === 'cancelled', `the resting order is cancelled during the wind-down: ${c2.order.state}`); }
    await sleep(1500);
    const end = (await ok('POST', `${P}/accounts/${id}/reconcile`)).account;
    check(end.venueState.positions.length === 0 && end.venueState.openOrders.length === 0 && end.divergence === null, `end state on the venue: ${end.venueState.positions.length} position(s), ${end.venueState.openOrders.length} open order(s), equity ${end.venueState.state?.equity}, divergence ${end.divergence}`);
    const rv = await ok('POST', `${P}/accounts/${id}/authorization/revoke`, { cancelOpenOrders: true });
    check(rv.mode === 'READ_ONLY' && rv.mandate.phase === 'ended', `authorization revoked: mode ${rv.mode}, mandate ${rv.mandate.phase}`);
    log(`\norders: ${end.orders.map((x: { clientId: string; state: string; origin: string }) => `${x.clientId}=${x.state}`).join(', ')}`);
    log('FUNDED RUN COMPLETE.');
  }
  log(`\nrequests by host: ${JSON.stringify(traffic)}`);
  check(!Object.keys(traffic).some((k) => k.startsWith('api.hyperliquid.xyz')), 'no request reached Hyperliquid mainnet');
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  exit = 1;
} finally {
  signerSrv?.close();
  app?.server.closeAllConnections?.();
  await app?.close().catch(() => {});
  await sql?.end().catch(() => {});
  process.exit(exit);
}
