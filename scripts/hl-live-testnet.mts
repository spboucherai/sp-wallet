// Controlled live trading on the Hyperliquid TESTNET, end to end, with the real pieces: the real API server and its live
// routes, the real isolated signer class behind its real HMAC channel (with its own exchange prices), PostgreSQL, a software
// passkey producing real WebAuthn assertions, and the real testnet. Never mainnet: every request to api.hyperliquid.xyz is
// refused by this script before it leaves the process, and SPW_DERIV_LIVE_MAINNET is forced off.
//
// KEYS. The wallet seed is generated IN MEMORY by this script (a fresh BIP-39 phrase), is never printed, never written to
// disk, and is gone when the process ends. No existing key, seed or secrets file is read. The signer's state goes to a
// temporary directory; the database is `spw_hl_live_testnet` (dropped and recreated on each run).
//
// ─── HOW TO RUN ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   npx tsx scripts/hl-live-testnet.mts                      unfunded run (default): needs nothing, sends nothing of value.
//
//       derive the trading key → create the venue account (READ_ONLY) → prepare the authorization (jurisdiction text, hashes)
//       → approve it with the passkey → the signer signs approveAgent with the wallet key → the venue answers
//       "Must deposit before performing actions. User: 0x…" (its documented answer for an account that never deposited) →
//       the API revokes the signer authorization. The script then drives the signer directly, to show what the trading key
//       signs and what the venue says about it: an order (passkey), a cancel (no passkey), a leverage change (passkey) —
//       the venue answers "User or API Wallet 0x<our trading key> does not exist.", i.e. it recovered OUR trading key from
//       the signature: its hash of the action (expiry included) equals ours. It also shows the signer's refusals with real
//       exchange prices (far-off-market order, smuggled approveAgent, transfer) and, finally, halt and revoke.
//       `--record` writes the exchanges to packages/derivatives/test/fixtures/hyperliquid/testnet-live-proof.json.
//
//   npx tsx scripts/hl-live-testnet.mts --wait-funding 900   funded run: the whole flow, for the owner.
//
//       The testnet faucet only serves an address that has deposited on MAINNET, which a throwaway seed never has. So the
//       script prints the account address and waits (here up to 900 s) for mock USDC to arrive on it:
//         1. open https://app.hyperliquid-testnet.xyz with a testnet account of yours that holds mock USDC (faucet:
//            https://app.hyperliquid-testnet.xyz/drip — it requires that this account of yours deposited on mainnet once);
//         2. send 50 mock USDC to the address the script printed (Portfolio → Send, "USDC (Perps)"; this is the `usdSend`
//            action on TESTNET — an address the venue has never credited "does not exist" for it);
//         3. leave the script running: it sees the balance and continues by itself.
//       It then runs, checking the venue's own state after each step: authorize (the venue lists the trading key as API
//       wallet) → leverage 3× cross (passkey) → post-only limit buy 2 % below the mark (passkey) → reconciled `open` →
//       cancel (no passkey) → reconciled `cancelled` → market buy of about 15 USDC (passkey) → fill, position → close
//       (reduce-only, passkey) → halt → a new order is refused → cancel-all → revoke. About 20 mock USDC are enough.
//       The mock USDC left on the throwaway account are lost with its key (they are worth nothing).
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
  createHlTrading, hlPinnedAssets, jurisdictionAck, recoverTypedDataSigner, venueAuthorizationHash, venueLeverageHash, venueOrderHash,
  type HlL1SignPayload, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueLeverage, type VenueOrder,
} from '../packages/derivatives/src/live/index.ts';
import { D } from '../packages/derivatives/src/index.ts';
import { buildUsdClassTransferTypedDataOnly } from '../packages/derivatives/src/venues/hyperliquid/signing.ts';
import { HL_API, hlQuantizePrice } from '../packages/derivatives/src/venues/hyperliquid/index.ts';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../services/isolated-signer/src/prices.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const NETWORK = 'testnet' as const, TESTNET = 'https://api.hyperliquid-testnet.xyz';
if (HL_API[NETWORK] !== TESTNET) throw new Error('refusing to run: not the testnet endpoint');
const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'l'.repeat(48), DB = 'spw_hl_live_testnet', BTC = 'hyperliquid:BTC', P = '/api/v1/derivatives/live';
const flag = (name: string) => process.argv.includes(`--${name}`), arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const waitFunding = Number(arg('wait-funding') ?? 0), SIZE = arg('size') ?? '0.0002';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);
const b64 = (hexHash: string) => Buffer.from(hexHash, 'hex');

// ── a guard in front of every outgoing request: nothing may reach Hyperliquid MAINNET from this script ────────────────────
const realFetch = globalThis.fetch, traffic: Record<string, number> = {};
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (u.host === 'api.hyperliquid.xyz') throw new Error(`refusing a request to Hyperliquid MAINNET (${u.pathname}) from the testnet script`);
  const k = `${u.host}${u.host.includes('hyperliquid') ? u.pathname : ''}`;
  traffic[k] = (traffic[k] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;
delete process.env.SPW_DERIV_LIVE_MAINNET;                                                            // the mainnet lock stays closed, whatever the shell says

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
  const dir = mkdtempSync(join(tmpdir(), 'spw-hl-live-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('testnet-setup').digest('hex');
  const signerCore = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, exchangePrices());   // the signer's OWN prices: Coinbase + Kraken
  signerSrv = createSignerServer(signerCore, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../services/api/src/db.ts'); sql = db.sql; await db.migrate();
  const { signer } = await import('../services/api/src/signer-client.ts');                            // the API's client of the signer: the real HMAC channel
  const { mainnetLiveEnabled } = await import('../services/api/src/derivatives/live.ts');
  if (mainnetLiveEnabled()) throw new Error('refusing to run: the mainnet setting is on');
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

  log(`Hyperliquid TESTNET live flow  ${new Date().toISOString()}`);
  log(`mainnet setting: ${(await ok('GET', `${P}/config`)).mainnetEnabled ? 'ON (unexpected)' : 'off'}; throwaway wallet ${ACCOUNT} (seed in memory only)`);

  // 1 ── the trading key: its own path, one per network, never the wallet key
  const key = await ok('POST', `${P}/venue-key`, { venue: 'hyperliquid', network: 'testnet' });
  const keyMain = await ok('POST', `${P}/venue-key`, { venue: 'hyperliquid', network: 'mainnet' });
  const AGENT = key.address as string;
  log(`\n1. trading key (API wallet)  testnet ${AGENT}  path ${key.path}\n                             mainnet ${keyMain.address}  path ${keyMain.path}  (derived only; nothing is ever sent to mainnet)`);
  check(new Set([AGENT, keyMain.address, ACCOUNT]).size === 3 && key.account === ACCOUNT, 'the trading keys differ from each other and from the wallet key');

  // 2 ── the venue account starts READ_ONLY
  const acct = await ok('POST', `${P}/accounts`, { venue: 'hyperliquid', network: 'testnet', label: 'HL testnet' });
  const id = acct.id as string;
  log(`\n2. venue account ${id}: mode ${acct.mode}, venue state: equity ${acct.venueState.state?.equity}, withdrawable ${acct.venueState.state?.withdrawable} (source: ${acct.venueState.source})`);
  check(acct.mode === 'READ_ONLY' && acct.tradable === false, 'a new venue account is READ_ONLY');
  const refusedRO = await api('POST', `${P}/accounts/${id}/orders`, { instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price: '50000' }, `ro-${Date.now()}`);
  check(refusedRO.status === 422 && refusedRO.json.error === 'mode_read_only', `an order on a READ_ONLY account is refused (${refusedRO.status} ${refusedRO.json.error})`);
  // v6: with the mainnet setting off a mainnet venue account is not even created (it used to be created READ_ONLY)
  const mainAcct = await api('POST', `${P}/accounts`, { venue: 'hyperliquid', network: 'mainnet', label: 'HL mainnet' });
  check(mainAcct.status === 403 && mainAcct.json.error === 'mainnet_disabled', `mainnet venue account with the setting off: ${mainAcct.status} ${mainAcct.json.error} — "${String(mainAcct.json.message).slice(0, 110)}…"`);

  // funding, when asked for
  let equity = D.from(acct.venueState.state?.equity ?? '0');
  if (waitFunding > 0 && D.lt(equity, D.from('15'))) {
    log(`\n   WAITING up to ${waitFunding} s for testnet mock USDC on ${ACCOUNT}\n   → send 50 mock USDC (Perps) to that address from a funded testnet account (see the top of this script).`);
    const until = Date.now() + waitFunding * 1000;
    while (Date.now() < until && D.lt(equity, D.from('15'))) { await sleep(5000); equity = D.from((await ok('GET', `${P}/accounts/${id}`)).venueState.state?.equity ?? '0'); }
    log(`   equity now ${D.str(equity)} USDC`);
  }
  const funded = D.gte(equity, D.from('15'));

  // 3 ── authorization: the jurisdiction summary is displayed, the passkey signs the authorization hash
  const POLICY = { allowedInstruments: [BTC], maxLeverage: 3, maxOrderNotional: '60', maxPositionNotional: '120', maxGrossExposure: '180', maxOrdersPerDay: 30, maxPriceDeviationBps: 1000 };
  const prep = await ok('POST', `${P}/accounts/${id}/authorization/prepare`, { policy: POLICY, days: 1, locale: 'en' });
  log(`\n3. authorization prepared: id ${prep.authorization.authorizationId}\n   hash ${prep.hash}\n   acknowledgement (${prep.acknowledgement.locale}, version ${prep.acknowledgement.version}) sha256 ${prep.acknowledgement.sha256}`);
  log(`   text shown to the owner (first line): "${String(prep.acknowledgement.text).split('\n')[0]}"`);
  check(prep.authorization.ackSha256 === jurisdictionAck('hyperliquid', 'en').sha256 && prep.options.challenge === b64(prep.hash).toString('base64url'), 'the authorization commits to the acknowledgement hash; the WebAuthn challenge is the authorization hash');
  const approve = await api('POST', `${P}/accounts/${id}/authorization/approve`, { assertion: pk.assert(b64(prep.hash)), acknowledged: true });
  record.push({ step: 'API authorization/approve (signer signs approveAgent with the wallet key; the API sends it to the testnet)', status: approve.status, answer: approve.status === 200 ? { mode: approve.json.mode } : approve.json });

  if (!funded) {
    // ── UNFUNDED: stop at the venue's documented refusal ─────────────────────────────────────────────────────────────────
    log(`\n   approve → HTTP ${approve.status} ${approve.json.error}\n   "${approve.json.message}"`);
    check(approve.status === 422 && approve.json.error === 'venue_rejected' && String(approve.json.message).includes(`Must deposit before performing actions. User: ${ACCOUNT}`),
      'the venue recovered the WALLET key from the approveAgent signature and refused for its documented reason (no deposit)');
    const st1 = await signer.status(true);
    check(st1.venues?.length === 1 && st1.venues[0]!.revoked === true, 'the signer authorization was revoked: nothing dangles');
    check((await ok('GET', `${P}/accounts/${id}`)).mode === 'READ_ONLY', 'the venue account is still READ_ONLY');
    const audit = await sql`select type from audit_events where data->>'account' = ${id} order by seq`;
    check(audit.some((a: { type: string }) => a.type === 'deriv.live.acknowledged') && audit.some((a: { type: string }) => a.type === 'deriv.live.authorization_failed'), `audit log: ${audit.map((a: { type: string }) => a.type).join(', ')}`);

    // ── what the TRADING key signs, and what the venue says about it (signer driven directly; the account stays unfunded) ───
    log('\n4. the signer, driven directly (same HMAC channel as the API), to show the trading key at work on an account the venue does not know');
    const nowS = Math.floor(Date.now() / 1000);
    const auth: VenueAuthorization = { v: 1, authorizationId: crypto.randomUUID(), keyId: st1.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-live', mode: 'MANUAL_LIVE',
      policy: POLICY, createdAt: nowS, expiresAt: nowS + 86400, approveNonce: Date.now(), ackSha256: jurisdictionAck('hyperliquid', 'en').sha256 };
    const mandate = await signer.venueAuthorize({ ...auth, mode: 'MANDATE_LIVE' }, pk.assert(venueAuthorizationHash({ ...auth, mode: 'MANDATE_LIVE' }))).then(() => 'accepted', (e: Error & { code?: string }) => `${e.code}: ${e.message}`);
    check(/MANDATE_LIVE/.test(mandate), `MANDATE_LIVE is refused by name — ${mandate.slice(0, 130)}`);
    const granted = await signer.venueAuthorize(auth, pk.assert(venueAuthorizationHash(auth)));
    const agentAction = granted.approve.action as { agentAddress: string; agentName: string };
    check(agentAction.agentAddress === AGENT, `authorization ${auth.authorizationId} stored; the wallet key signed approveAgent for ${agentAction.agentAddress} ("${agentAction.agentName}")`);
    await postExchange('approveAgent signed by the wallet key (user-signed action)', { action: granted.approve.action, nonce: granted.approve.nonce, signature: granted.approve.signature, vaultAddress: null, expiresAfter: null });

    const trading = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: 90_000 });
    const venueApi = (await import('../services/api/src/derivatives/live.ts')).live().deps.venues.get('testnet');
    const inst = await venueApi.instrument(BTC), { ticker } = await venueApi.market(inst);
    await venueApi.assertPinned();
    log(`   live testnet BTC mark ${ticker.mark}, oracle ${ticker.index}; pinned asset table matches the venue's live meta`);
    const px = (factor: string, mode: 'down' | 'up') => hlQuantizePrice(D.str(D.div(D.mul(D.from(ticker.mark), D.from(factor)), D.one, 1, mode)), 5, mode);
    let nonce = Date.now();
    const canonicalOf = (req: OrderRequest, n: number): VenueOrder => { const x = trading.normalizeRequest(req, inst); return { v: 1, authorizationId: auth.authorizationId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, kind: 'order',
      instrument: x.instrument, side: x.side, type: x.type as VenueOrder['type'], size: x.size, price: x.price!, triggerPrice: x.triggerPrice, reduceOnly: x.reduceOnly, tif: x.tif, clientId: x.clientId, nonce: n, expiresAt: n + 90_000 }; };
    const sign = (p: { sign: SignRequest; context?: unknown; assertion?: unknown }) => signer.venueSign({ authorizationId: auth.authorizationId, ...p }).then((r) => ({ ok: true as const, ...r }), (e: Error & { code?: string }) => ({ ok: false as const, error: `${e.code}: ${e.message}` }));
    const names = (answer: unknown, who: string) => JSON.stringify(answer).toLowerCase().includes(who);

    // (a) an order, approved with the passkey
    const req: OrderRequest = { instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price: px('0.98', 'down'), triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: `live-proof-${nonce}` };
    nonce = Math.max(Date.now(), nonce + 1);
    const built = trading.buildOrder(req, { instrument: inst, nonce }), canonical = canonicalOf(req, nonce);
    const noPasskey = await sign({ sign: built.sign, context: { order: canonical } });
    check(!noPasskey.ok && /bad_approval/.test(noPasskey.error), `order without a passkey assertion — ${noPasskey.ok ? 'SIGNED' : noPasskey.error}`);
    const signed = await sign({ sign: built.sign, context: { order: canonical }, assertion: pk.assert(venueOrderHash(canonical)) });
    if (!check(signed.ok, `order ${req.side} ${req.size} BTC @ ${req.price} post-only, passkey over ${Buffer.from(venueOrderHash(canonical)).toString('hex').slice(0, 16)}… — ${signed.ok ? `signed by ${signed.signer}` : signed.error}`)) throw new Error('the signer refused the order');
    if (signed.ok) {
      check(signed.signer === AGENT && await recoverTypedDataSigner((built.sign.payload as HlL1SignPayload).typedData, signed.signature) === AGENT, 'the signature is the TRADING key\'s (recovered locally)');
      const r = await postExchange('order signed by the trading key (expiresAfter = nonce + 90 s)', { action: built.action, nonce, signature: signed.signature, vaultAddress: null, expiresAfter: nonce + 90_000 });
      check(names(r.body, AGENT) && /does not exist/.test(JSON.stringify(r.body)), 'the venue names OUR trading key: it recovered it from the signature, so its hash of the action (expiry included) equals ours');
      check(!names(r.body, ACCOUNT), 'the wallet key appears nowhere in the order path');
    }
    // (b) a cancel needs no passkey
    nonce = Math.max(Date.now(), nonce + 1);
    const cancel = trading.buildCancel({ instrument: inst, clientId: req.clientId, nonce }), cs = await sign({ sign: cancel.sign });
    check(cs.ok, `cancel by client id, no passkey — ${cs.ok ? 'signed' : cs.error}`);
    if (cs.ok) { const r = await postExchange('cancelByCloid signed by the trading key', { action: cancel.action, nonce, signature: cs.signature, vaultAddress: null, expiresAfter: nonce + 90_000 }); check(names(r.body, AGENT), 'the venue names our trading key'); }
    // (c) a leverage change needs the passkey and stays within the authorization
    nonce = Math.max(Date.now(), nonce + 1);
    const lev = trading.buildUpdateLeverage({ instrument: inst, leverage: 3, marginMode: 'cross', nonce });
    const lc: VenueLeverage = { v: 1, authorizationId: auth.authorizationId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, kind: 'leverage', instrument: BTC, leverage: 3, marginMode: 'cross', nonce, expiresAt: nonce + 90_000 };
    const ls = await sign({ sign: lev.sign, context: { leverage: lc }, assertion: pk.assert(venueLeverageHash(lc)) });
    check(ls.ok, `leverage 3× cross, passkey — ${ls.ok ? 'signed' : ls.error}`);
    if (ls.ok) { const r = await postExchange('updateLeverage signed by the trading key', { action: lev.action, nonce, signature: ls.signature, vaultAddress: null, expiresAfter: nonce + 90_000 }); check(names(r.body, AGENT), 'the venue names our trading key'); }

    // (d) what the signer refuses, with its real exchange prices
    log('\n5. signer refusals (nothing below is sent to the venue)');
    const refused = async (what: string, want: RegExp, p: Parameters<typeof sign>[0]) => { const r = await sign(p); check(!r.ok && want.test(r.error), `${what} — ${r.ok ? 'SIGNED (unexpected)' : r.error.slice(0, 150)}`); record.push({ step: `signer: ${what}`, answer: r.ok ? 'signed' : r.error }); };
    const mk = (o: Partial<OrderRequest>) => { nonce = Math.max(Date.now(), nonce + 1); const r2 = { ...req, clientId: `live-proof-${nonce}`, ...o }; const b = trading.buildOrder(r2, { instrument: inst, nonce }), c = canonicalOf(r2, nonce); return { sign: b.sign, context: { order: c }, assertion: pk.assert(venueOrderHash(c)) }; };
    await refused('order at half the market price (passkey-approved all the same)', /^signer_price: /, mk({ price: px('0.5', 'down'), size: '0.0005' }));
    await refused('order above the authorized notional', /^signer_policy: order notional/, mk({ size: '0.01' }));
    const eth = { ...inst, symbol: 'ETH', id: 'hyperliquid:ETH', lotSize: '0.0001' };
    nonce = Math.max(Date.now(), nonce + 1);
    const ethReq: OrderRequest = { instrument: eth.id, side: 'buy', type: 'limit', size: '0.01', price: '1000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `live-proof-eth-${nonce}` };
    const ethBuilt = trading.buildOrder(ethReq, { instrument: eth, nonce }), ethX = trading.normalizeRequest(ethReq, eth);
    const ethC: VenueOrder = { ...canonicalOf(req, nonce), instrument: ethX.instrument, size: ethX.size, price: ethX.price!, tif: ethX.tif, clientId: ethX.clientId };
    await refused('order on an instrument outside the authorization', /^signer_policy: hyperliquid:ETH is not allowed/, { sign: ethBuilt.sign, context: { order: ethC }, assertion: pk.assert(venueOrderHash(ethC)) });
    const tampered = mk({}); const shown = structuredClone(tampered.context.order); shown.size = '0.0001';
    await refused('payload differs from the order shown for approval', /^signer_mismatch: /, { sign: tampered.sign, context: { order: shown }, assertion: pk.assert(venueOrderHash(shown)) });
    nonce = Math.max(Date.now(), nonce + 1);
    await refused('an approveAgent for another address smuggled through /venue/sign', /agent approval can only be signed through \/venue\/authorize/, { sign: trading.buildApproveAgent({ agentAddress: `0x${'66'.repeat(20)}`, agentName: 'evil', nonce }).sign });
    const xfer = buildUsdClassTransferTypedDataOnly({ network: 'testnet', amount: '10', toPerp: false, nonce });
    await refused('a transfer (usdClassTransfer) smuggled through /venue/sign', /not an order, a cancel or a leverage change/, { sign: { venue: 'hyperliquid', network: 'testnet', kind: 'hl_user', payload: { scheme: 'user', action: xfer.action, typedData: xfer.typedData } } });

    // (e) halt and revoke: stopping needs no passkey
    log('\n6. stopping');
    const halted = await ok('POST', `${P}/accounts/${id}/halt`, { reason: 'testnet script' });
    check(typeof halted.halt === 'string' && halted.riskEvents.some((e: { kind: string }) => e.kind === 'halt'), `halt (no passkey): "${halted.halt}"`);
    const rv = await signer.venueRevoke(auth.authorizationId);
    check(rv.revoked === true, `revoke (no passkey) at ${rv.revokedAt}`);
    nonce = Math.max(Date.now(), nonce + 1);
    await refused('a cancel after revocation', /^signer_revoked: /, { sign: trading.buildCancel({ instrument: inst, clientId: req.clientId, nonce }).sign });
    await refused('an order after revocation', /^signer_revoked: /, mk({}));
    const stEnd = await signer.status(true);
    check(stEnd.venues!.every((v) => v.revoked), `signer: ${stEnd.venues!.length} authorization(s), all revoked; journal ${stEnd.journalLength} entries`);

    log('\nUNFUNDED RUN COMPLETE: it stopped where the venue refuses an account that never deposited. To run the funded flow, see the top of this script (--wait-funding).');
    if (flag('record')) {
      writeFileSync(new URL('../packages/derivatives/test/fixtures/hyperliquid/testnet-live-proof.json', import.meta.url), `${JSON.stringify({ recordedAt: new Date().toISOString(), network: NETWORK,
        note: 'throwaway seed generated in memory by scripts/hl-live-testnet.mts; the account never existed on the venue', account: ACCOUNT, agent: AGENT, exchanges: record }, null, 1)}\n`);
      log('recorded → packages/derivatives/test/fixtures/hyperliquid/testnet-live-proof.json');
    }
  } else {
    // ── FUNDED: the whole flow through the API ───────────────────────────────────────────────────────────────────────────
    if (approve.status !== 200) throw new Error(`authorization approval failed: ${approve.status} ${JSON.stringify(approve.json)}`);
    check(approve.json.mode === 'MANUAL_LIVE' && approve.json.authorization.active === true, 'authorized: mode MANUAL_LIVE; the venue lists the trading key as an API wallet of the account');
    const detail = async () => ok('GET', `${P}/accounts/${id}`);
    const reconcile = async () => ok('POST', `${P}/accounts/${id}/reconcile`);
    const propose = async (body: Record<string, unknown>, k = `live-${Date.now()}`) => { const p = await api('POST', `${P}/accounts/${id}/orders`, body, k); if (p.status !== 200) throw new Error(`proposal refused: ${p.status} ${JSON.stringify(p.json)}`); return { k, p: p.json }; };
    const approveOrder = async (k: string, hash: string) => ok('POST', `${P}/accounts/${id}/orders/${k}/approve`, { assertion: pk.assert(b64(hash)) });
    const mark = D.from((await detail()).venueState.state ? (await (await import('../services/api/src/derivatives/live.ts')).live().deps.venues.get('testnet').market(await (await import('../services/api/src/derivatives/live.ts')).live().deps.venues.get('testnet').instrument(BTC))).ticker.mark : '0');

    log('\n4. leverage 3× cross (passkey)');
    const lp = await ok('POST', `${P}/accounts/${id}/leverage`, { instrument: BTC, leverage: 3, marginMode: 'cross' });
    const la = await ok('POST', `${P}/accounts/${id}/leverage/${lp.action.id}/approve`, { assertion: pk.assert(b64(lp.hash)) });
    check(la.venue.confirmed === true, `the venue's own setting is now ${JSON.stringify(la.venue.leverage)}`);

    log('\n5. post-only limit buy 2 % below the mark (passkey) → open → cancel (no passkey)');
    const price = hlQuantizePrice(D.str(D.div(D.mul(mark, D.from('0.98')), D.one, 1, 'down')), 5, 'down');
    const a = await propose({ instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price, tif: 'alo' });
    log(`   proposal ${a.k}: state ${a.p.order.state}, hash ${a.p.hash}, canonical ${JSON.stringify(a.p.canonical)}`);
    const ar = await approveOrder(a.k, a.p.hash);
    check(ar.order.state === 'open' && ar.order.source === 'venue', `after approval: state ${ar.order.state} (source ${ar.order.source}), venue order id ${ar.order.venueOrderId}`);
    const again = await ok('POST', `${P}/accounts/${id}/orders/${a.k}/approve`, { assertion: pk.assert(b64(a.p.hash)) });
    check(again.idempotent === true, 'approving the same order again sends nothing');
    await sleep(1500);
    const d1 = (await reconcile()).account;
    check(d1.venueState.openOrders.some((x: { clientId: string }) => x.clientId === a.p.canonical.clientId), 'the venue lists the order as open with our client order id');
    const cr = await ok('POST', `${P}/accounts/${id}/orders/${a.k}/cancel`);
    check(cr.order.state === 'cancelled' && cr.sent === true, `cancel: venue ${JSON.stringify(cr.venue)}, state ${cr.order.state}`);

    log('\n6. market buy (passkey) → fill → position');
    const m = await propose({ instrument: BTC, side: 'buy', type: 'market', size: SIZE, slippageBps: 100, tif: 'ioc' });
    const mr = await approveOrder(m.k, m.p.hash);
    check(['filled', 'partially_filled'].includes(mr.order.state), `market order: ${mr.order.state}, filled ${mr.order.filled} @ ${mr.order.avgFillPrice} (worst price ${m.p.canonical.price})${mr.order.reason ? ` — ${mr.order.reason}` : ''}`);
    await sleep(1500);
    const d2 = (await reconcile()).account;
    const pos = d2.venueState.positions.find((x: { instrument: string }) => x.instrument === BTC);
    check(!!pos && d2.divergence === null, `venue position: ${pos ? `${pos.side} ${pos.size} @ ${pos.entryPrice}, leverage ${pos.leverage} ${pos.marginMode}` : 'none'}; divergence: ${d2.divergence}`);
    check(d2.fills.length > 0, `${d2.fills.length} fill(s) recorded from the venue, fees ${d2.fills.map((f: { fee: string }) => f.fee).join(' + ')}`);

    log('\n7. close (reduce-only, passkey), then the kill switch');
    if (pos) {
      const c = await api('POST', `${P}/accounts/${id}/close`, { instrument: BTC, fraction: '1', slippageBps: 100 }, `close-${Date.now()}`);
      if (c.status !== 200) throw new Error(`close refused: ${c.status} ${JSON.stringify(c.json)}`);
      const done = await approveOrder(c.json.order.clientId, c.json.hash);
      check(['filled', 'partially_filled'].includes(done.order.state), `close: ${done.order.state}, filled ${done.order.filled} @ ${done.order.avgFillPrice} (worst ${c.json.worstPrice}, bound ${c.json.slippageBoundBps} bps)`);
      await sleep(1500);
    }
    const rest = await propose({ instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price, tif: 'alo' });
    await approveOrder(rest.k, rest.p.hash);
    const h = await ok('POST', `${P}/accounts/${id}/halt`, { reason: 'testnet script' });
    check(h.venueState.openOrders.length >= 1, `halt: "${h.halt}" — the resting order is still on the venue (${h.venueState.openOrders.length})`);
    const blocked = await api('POST', `${P}/accounts/${id}/orders`, { instrument: BTC, side: 'buy', type: 'limit', size: SIZE, price, tif: 'alo' }, `halted-${Date.now()}`);
    check(blocked.status === 422 && blocked.json.error === 'halted', `a new order while halted: ${blocked.status} ${blocked.json.error}`);
    const ca = await ok('POST', `${P}/accounts/${id}/cancel-all`);
    check(ca.accepted === ca.requested && ca.remaining.length === 0, `cancel-all: ${ca.accepted}/${ca.requested} accepted, ${ca.remaining.length} remaining`);
    await sleep(1500);
    const end = (await reconcile()).account;
    check(end.venueState.positions.length === 0 && end.venueState.openOrders.length === 0, `end state on the venue: ${end.venueState.positions.length} position(s), ${end.venueState.openOrders.length} open order(s), equity ${end.venueState.state?.equity}`);
    const rv = await ok('POST', `${P}/accounts/${id}/authorization/revoke`, { cancelOpenOrders: true });
    check(rv.mode === 'READ_ONLY', `revoked: mode ${rv.mode}`);
    log(`\norders: ${end.orders.map((x: { clientId: string; state: string }) => `${x.clientId}=${x.state}`).join(', ')}`);
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
