/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/hl-testnet.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Hyperliquid TESTNET proof of the adapter's signing and trading path. Never mainnet: the network is hard-coded and checked.
//
// Keys: every key used here is generated in memory by this script, is never printed and never written to disk, and is gone
// when the process ends. No existing key, seed or secrets file is read.
//
//   npx tsx scripts/hl-testnet.mts proof [--record]
//       No funds needed. A throwaway account key signs one action of each type the adapter builds (approveAgent, order, cancel,
//       cancelByCloid, updateLeverage, order with expiresAfter) and sends it to the testnet exchange endpoint. The venue has no
//       such account, so it refuses each one for a BUSINESS reason that names the signer it recovered from the signature — when
//       that address is ours, the venue computed the same hash as we did. Deliberately wrong signatures are sent as well, to
//       show that they are refused differently (another address, or a recovery error). --record writes the exchanges to
//       packages/derivatives/test/fixtures/hyperliquid/testnet-exchange-proof.json (addresses and answers only).
//
//   npx tsx scripts/hl-testnet.mts full --account 0x<funded testnet account>
//       Needs a testnet account with mock USDC (see docs/v4/venues/hyperliquid.md, "Funding a testnet account"). The script
//       creates an API wallet key in memory, prints its ADDRESS and waits until the owner has authorized that address for the
//       account (approveAgent, signed with the account's own wallet in the testnet web interface). It then runs
//       leverage → resting order → cancel → market order → fill → position → stop order → cancel → close → reconcile,
//       checking the venue's own state after every step. The account key is never needed.
import { writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAddress, sign } from 'viem/accounts';
import type { Hex } from 'viem';
import { D, VenueError, type Instrument, type OrderRequest, type SignRequest } from '../packages/derivatives/src/index.ts';
import {
  HL_API, createHlNonceSource, createHyperliquidAdapter, hlCloid, hlQuantizePrice, l1SignPayload, recoverTypedDataSigner, signatureFromHex, typedDataDigest,
  type HlL1SignPayload, type HlSignature, type HlTrading, type HlTypedData, type HlUserSignPayload,
} from '../packages/derivatives/src/venues/hyperliquid/index.ts';

const NETWORK = 'testnet' as const;
if (HL_API[NETWORK] !== 'https://api.hyperliquid-testnet.xyz') throw new Error('refusing to run: not the testnet endpoint');
const mode = process.argv[2] ?? 'proof', flag = (name: string) => process.argv.includes(`--${name}`), arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);

/** what the isolated signer does: describe first, refuse anything unexpected, then sign the EIP-712 digest */
async function signAs(key: Hex, trading: HlTrading, request: SignRequest, expect: string): Promise<HlSignature> {
  const d = trading.describe(request);
  if (d.kind !== expect) throw new Error(`describe says '${d.kind}', expected '${expect}'`);
  const td = (request.payload as HlL1SignPayload | HlUserSignPayload).typedData;
  return signatureFromHex(await sign({ hash: typedDataDigest(td), privateKey: key, to: 'hex' }));
}
const signTyped = async (key: Hex, td: HlTypedData): Promise<HlSignature> => signatureFromHex(await sign({ hash: typedDataDigest(td), privateKey: key, to: 'hex' }));

/** raw POST /exchange on TESTNET, to record the venue's exact words (the adapter's submit maps them to VenueError) */
async function postExchange(body: unknown): Promise<{ status: number; body: unknown; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(`${HL_API[NETWORK]}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, ms: Date.now() - t0 };
}

const adapter = createHyperliquidAdapter({ network: NETWORK });
const trading = await adapter.loadTrading();
const instruments = await adapter.instruments();
const BTC = instruments.find((i) => i.symbol === 'BTC')!;
const nonces = createHlNonceSource();

// =============================================================================================================================
async function proof(): Promise<void> {
  const key = generatePrivateKey(), account = privateKeyToAddress(key).toLowerCase();        // throwaway, in memory only
  const agent = privateKeyToAddress(generatePrivateKey()).toLowerCase();                      // only its address is used
  log(`testnet proof  ${new Date().toISOString()}`);
  log(`throwaway account ${account} (never funded)   agent address ${agent}`);
  const state = await adapter.account(account);
  log(`venue state of that account: equity ${state.equity}, withdrawable ${state.withdrawable}`);
  const tickers = await adapter.tickers(), mark = tickers.find((t) => t.instrument === BTC.id)!.mark;
  const price = hlQuantizePrice(D.str(D.div(D.mul(D.from(mark), D.from('9')), D.from('10'), 1, 'down')), 5, 'down'); // 10 % below the mark
  const req: OrderRequest = { instrument: BTC.id, side: 'buy', type: 'limit', size: '0.001', price, triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: `proof-${Date.now()}` };
  const names = (answer: unknown): string[] => [...JSON.stringify(answer).matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());
  const record: { step: string; signer: string; request: unknown; status: number; answer: unknown; namesSigner: boolean }[] = [];
  const run = async (step: string, action: unknown, nonce: number, signature: HlSignature, extra: Record<string, unknown> = {}) => {
    const body = { action, nonce, signature, vaultAddress: null, expiresAfter: null, ...extra };
    const r = await postExchange(body);
    const namesSigner = names(r.body).includes(account);
    record.push({ step, signer: account, request: body, status: r.status, answer: r.body, namesSigner });
    log(`\n[${step}]  HTTP ${r.status}  ${r.ms} ms\n  ${JSON.stringify(r.body)}\n  names our signer: ${namesSigner}${names(r.body).length && !namesSigner ? `  (names ${names(r.body).join(', ')})` : ''}`);
    await sleep(400);
    return r;
  };

  // 1. user-signed: approveAgent, signed by the throwaway account key
  { const nonce = nonces.next(), a = trading.buildApproveAgent({ agentAddress: agent, agentName: 'spw-proof', nonce }); await run('approveAgent (user-signed)', a.action, nonce, await signAs(key, trading, a.sign, 'approve_agent')); }
  // 2. L1 actions, signed by the throwaway key acting for itself
  { const nonce = nonces.next(), o = trading.buildOrder(req, { instrument: BTC, nonce }); await run('order: post-only limit buy', o.action, nonce, await signAs(key, trading, o.sign, 'order')); }
  { const nonce = nonces.next(), o = trading.buildOrder({ ...req, type: 'stop_market', side: 'sell', price, triggerPrice: price, reduceOnly: true, tif: 'gtc', clientId: `${req.clientId}-sl` }, { instrument: BTC, nonce });
    await run('order: stop market, reduce-only', o.action, nonce, await signAs(key, trading, o.sign, 'order')); }
  { const nonce = nonces.next(), c = trading.buildCancel({ instrument: BTC, venueOrderId: '123456789', nonce }); await run('cancel by order id', c.action, nonce, await signAs(key, trading, c.sign, 'cancel')); }
  { const nonce = nonces.next(), c = trading.buildCancel({ instrument: BTC, clientId: req.clientId, nonce }); await run('cancel by client order id', c.action, nonce, await signAs(key, trading, c.sign, 'cancel')); }
  { const nonce = nonces.next(), u = trading.buildUpdateLeverage({ instrument: BTC, leverage: 3, marginMode: 'cross', nonce }); await run('updateLeverage', u.action, nonce, await signAs(key, trading, u.sign, 'leverage')); }
  { // expiresAfter is part of the hash: a trading object configured with an expiry
    const withExpiry = await createHyperliquidAdapter({ network: NETWORK, trading: { expiresAfterMs: 60_000 } }).loadTrading();
    const nonce = nonces.next(), o = withExpiry.buildOrder({ ...req, clientId: `${req.clientId}-exp` }, { instrument: BTC, nonce });
    await run('order with expiresAfter = nonce + 60 s', o.action, nonce, await signAs(key, withExpiry, o.sign, 'order'), { expiresAfter: nonce + 60_000 }); }

  // 3. deliberately wrong signatures
  { // (a) a valid signature, but over another nonce: the venue recovers some other address
    const nonce = nonces.next(), o = trading.buildOrder({ ...req, clientId: `${req.clientId}-w1` }, { instrument: BTC, nonce });
    const other = l1SignPayload(o.action as never, { network: NETWORK, nonce: nonce + 1 }).typedData;
    const signature = await signTyped(key, other);
    await run('WRONG signature: signed for nonce + 1', o.action, nonce, signature);
    log(`  locally, that signature over the submitted payload recovers ${await recoverTypedDataSigner((o.sign.payload as HlL1SignPayload).typedData, signature)} — not ${account}`); }
  { // (b) a valid signature for MAINNET (source 'a') sent to testnet
    const nonce = nonces.next(), o = trading.buildOrder({ ...req, clientId: `${req.clientId}-w2` }, { instrument: BTC, nonce });
    await run('WRONG signature: phantom agent of mainnet', o.action, nonce, await signTyped(key, l1SignPayload(o.action as never, { network: 'mainnet', nonce }).typedData)); }
  { // (c) the action changed after signing (size × 10)
    const nonce = nonces.next(), o = trading.buildOrder({ ...req, clientId: `${req.clientId}-w3` }, { instrument: BTC, nonce });
    const signature = await signAs(key, trading, o.sign, 'order');
    const tampered = structuredClone(o.action); tampered.orders[0]!.s = '0.01';
    await run('WRONG signature: action changed after signing', tampered, nonce, signature); }
  { // (d) not a signature at all
    const nonce = nonces.next(), o = trading.buildOrder({ ...req, clientId: `${req.clientId}-w4` }, { instrument: BTC, nonce });
    await run('WRONG signature: r = s = 0', o.action, nonce, { r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}`, v: 27 }); }

  // 4. the same refusals through the adapter's own submit(): VenueError('rejected')
  { const nonce = nonces.next(), o = trading.buildOrder({ ...req, clientId: `${req.clientId}-sub` }, { instrument: BTC, nonce });
    try { await trading.submit(o.action, await signAs(key, trading, o.sign, 'order'), nonce); log('\n[adapter.submit] accepted — unexpected'); }
    catch (e) { log(`\n[adapter.submit]  ${e instanceof VenueError ? `VenueError(${e.code}): ${e.message}` : e}`); } }

  const good = record.filter((r) => !r.step.startsWith('WRONG')), wrong = record.filter((r) => r.step.startsWith('WRONG'));
  log(`\nsummary: ${good.filter((r) => r.namesSigner).length}/${good.length} correctly signed actions were refused for a reason naming OUR signer;`);
  log(`         ${wrong.filter((r) => !r.namesSigner).length}/${wrong.length} wrong signatures were refused WITHOUT naming our signer.`);
  if (flag('record')) {
    writeFileSync(new URL('../packages/derivatives/test/fixtures/hyperliquid/testnet-exchange-proof.json', import.meta.url), `${JSON.stringify({ recordedAt: new Date().toISOString(), network: NETWORK, note: 'throwaway key generated in memory by scripts/hl-testnet.mts; the account never existed on the venue', account, exchanges: record }, null, 1)}\n`);
    log('recorded → packages/derivatives/test/fixtures/hyperliquid/testnet-exchange-proof.json');
  }
  if (good.some((r) => !r.namesSigner) || wrong.some((r) => r.namesSigner)) process.exitCode = 1;
}

// =============================================================================================================================
async function full(): Promise<void> {
  const account = (arg('account') ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(account)) throw new Error('usage: hl-testnet.mts full --account 0x<funded testnet account>');
  const agentKey = generatePrivateKey(), agent = privateKeyToAddress(agentKey).toLowerCase(); // API wallet: in memory only
  const check = (ok: boolean, what: string) => { log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { process.exitCode = 1; throw new Error(`check failed: ${what}`); } };
  const role = async (user: string) => (await adapter.http.info({ type: 'userRole', user })) as { role: string; data?: { user?: string } };

  const before = await adapter.account(account);
  log(`account ${account}: equity ${before.equity} USDC, withdrawable ${before.withdrawable}`);
  check(D.cmp(D.from(before.withdrawable ?? '0'), D.from('30')) >= 0, 'at least 30 mock USDC available (fund the account first)');
  check((await adapter.positions(account)).every((p) => p.instrument !== BTC.id), 'no BTC position at the start');

  log(`\nAuthorize this address as an API wallet (agent) of the account, on TESTNET, signing with the account's own wallet:\n  address: ${agent}   suggested name: spw-test\n  (web interface: the API page, expected at https://app.hyperliquid-testnet.xyz/API — see docs/v4/venues/hyperliquid.md)\nwaiting until the venue reports it as approved (10 minutes at most) …`);
  let approved = false;
  for (let i = 0; i < 60 && !approved; i++) { const r = await role(agent); approved = r.role === 'agent' && r.data?.user?.toLowerCase() === account; if (!approved) await sleep(10_000); }
  check(approved, 'the venue reports the agent as approved for the account (userRole)');

  const events: { type: string }[] = [];
  const stop = adapter.stream({ type: 'account', account }, (e) => events.push(e as { type: string }), (s) => log(`  [stream] ${s}`));
  const send = async (label: string, built: { action: unknown; sign: SignRequest }, nonce: number, kind: string) => {
    const sig = await signAs(agentKey, trading, built.sign, kind);
    try { const r = await trading.submit(built.action, sig, nonce); log(`  ${label}: accepted ${JSON.stringify(r.raw)}`); return r; }
    catch (e) { log(`  ${label}: ${e instanceof VenueError ? `${e.code} — ${e.message}` : e}`); throw e; }
  };
  const settle = () => sleep(1500);
  const ticker = async () => (await adapter.tickers()).find((t) => t.instrument === BTC.id)!;
  const scaled = (price: string, num: string, den: string, mode: 'down' | 'up') => hlQuantizePrice(D.str(D.div(D.mul(D.from(price), D.from(num)), D.from(den), 6, mode)), 5, mode);
  // smallest size worth at least 12 USDC at the mark (the venue's minimum order value is 10)
  const mark = (await ticker()).mark, size = D.str(D.quantize(D.div(D.from('12'), D.from(mark), 8, 'up'), D.from(BTC.lotSize), 'up'));
  const id = `full-${Date.now()}`, base: Omit<OrderRequest, 'type' | 'side' | 'price' | 'tif' | 'clientId'> = { instrument: BTC.id, size, triggerPrice: null, reduceOnly: false };
  log(`\nBTC mark ${mark}, order size ${size}`);

  log('\n1. leverage 3x cross');
  { const nonce = nonces.next(); await send('updateLeverage', trading.buildUpdateLeverage({ instrument: BTC, leverage: 3, marginMode: 'cross', nonce }), nonce, 'leverage'); }

  log('\n2. resting post-only buy 10 % below the mark');
  const restPrice = scaled(mark, '9', '10', 'down');
  { const nonce = nonces.next(); const r = await send('order', trading.buildOrder({ ...base, type: 'limit', side: 'buy', price: restPrice, tif: 'alo', clientId: `${id}-rest` }, { instrument: BTC, nonce }), nonce, 'order');
    await settle();
    const open = (await adapter.openOrders(account)).find((o) => o.clientId === hlCloid(`${id}-rest`));
    check(!!open && open.venueOrderId === r.venueOrderIds[0] && open.status === 'open' && open.price === restPrice && open.size === size && open.tif === 'alo', 'the venue lists the order as open, with our price, size, post-only and client id'); }

  log('\n3. cancel it by client order id');
  { const nonce = nonces.next(); await send('cancel', trading.buildCancel({ instrument: BTC, clientId: `${id}-rest`, nonce }), nonce, 'cancel');
    await settle();
    check(!(await adapter.openOrders(account)).some((o) => o.clientId === hlCloid(`${id}-rest`)), 'the order is no longer open');
    check((await adapter.orderHistory(account, { limit: 50 })).some((o) => o.clientId === hlCloid(`${id}-rest`) && o.status === 'cancelled'), 'order history shows it cancelled'); }

  log('\n4. market buy (immediate-or-cancel, worst price 2 % above the best ask)');
  let boughtOid = '';
  { const book = await adapter.book(BTC.symbol, 5), worst = scaled(book.asks[0]![0], '102', '100', 'up'), nonce = nonces.next();
    const r = await send('order', trading.buildOrder({ ...base, type: 'market', side: 'buy', price: worst, tif: 'ioc', clientId: `${id}-buy` }, { instrument: BTC, nonce }), nonce, 'order');
    boughtOid = r.venueOrderIds[0] ?? '';
    await settle();
    const fills = (await adapter.fills(account, { start: Date.now() - 600_000 })).filter((f) => f.orderId === boughtOid);
    const filled = fills.reduce((n, f) => D.add(n, D.from(f.size)), D.from('0'));
    check(fills.length > 0 && D.cmp(filled, D.from(size)) === 0 && fills.every((f) => f.side === 'buy' && D.cmp(D.from(f.price), D.from(worst)) <= 0), `the venue reports ${fills.length} fill(s) for the order, total ${D.str(filled)}, none above the worst price`);
    const pos = (await adapter.positions(account)).find((p) => p.instrument === BTC.id);
    check(!!pos && pos.side === 'long' && pos.size === size && pos.leverage === '3' && pos.marginMode === 'cross', `position: long ${pos?.size} at ${pos?.entryPrice}, 3x cross, liquidation ${pos?.liquidationPrice}`); }

  log('\n5. protective stop: reduce-only stop market 10 % below the mark, then cancel it by order id');
  { const m = (await ticker()).mark, trigger = scaled(m, '9', '10', 'down'), limit = scaled(m, '8', '10', 'down'), nonce = nonces.next();
    await send('order', trading.buildOrder({ ...base, type: 'stop_market', side: 'sell', price: limit, triggerPrice: trigger, reduceOnly: true, tif: 'gtc', clientId: `${id}-stop` }, { instrument: BTC, nonce }), nonce, 'order');
    await settle();
    const stopOrder = (await adapter.openOrders(account)).find((o) => o.clientId === hlCloid(`${id}-stop`));
    check(!!stopOrder && stopOrder.type === 'stop_market' && stopOrder.triggerPrice === trigger && stopOrder.reduceOnly, 'the venue lists the stop as an open reduce-only trigger order');
    const n2 = nonces.next(); await send('cancel', trading.buildCancel({ instrument: BTC, venueOrderId: stopOrder!.venueOrderId!, nonce: n2 }), n2, 'cancel');
    await settle();
    check(!(await adapter.openOrders(account)).some((o) => o.clientId === hlCloid(`${id}-stop`)), 'the stop is no longer open'); }

  log('\n6. close: reduce-only market sell (worst price 2 % below the best bid)');
  { const book = await adapter.book(BTC.symbol, 5), worst = scaled(book.bids[0]![0], '98', '100', 'down'), nonce = nonces.next();
    await send('order', trading.buildOrder({ ...base, type: 'market', side: 'sell', price: worst, tif: 'ioc', reduceOnly: true, clientId: `${id}-close` }, { instrument: BTC, nonce }), nonce, 'order');
    await settle();
    check(!(await adapter.positions(account)).some((p) => p.instrument === BTC.id), 'no BTC position left'); }

  log('\n7. a refusal on purpose: an order below the venue minimum value');
  { const nonce = nonces.next(), tiny = trading.buildOrder({ ...base, size: BTC.lotSize, type: 'limit', side: 'buy', price: restPrice, tif: 'alo', clientId: `${id}-tiny` }, { instrument: BTC, nonce });
    let refused = '';
    try { await trading.submit(tiny.action, await signAs(agentKey, trading, tiny.sign, 'order'), nonce); } catch (e) { refused = e instanceof VenueError && e.code === 'rejected' ? e.message : ''; }
    check(refused.length > 0, `rejected by the venue: ${refused}`); }

  log('\n8. reconcile');
  await settle();
  const after = await adapter.account(account), fills = await adapter.fills(account, { start: Date.now() - 900_000 });
  const mine = fills.filter((f) => [hlCloid(`${id}-buy`), hlCloid(`${id}-close`)].includes(f.clientId ?? ''));
  const fees = mine.reduce((n, f) => D.add(n, D.from(f.fee)), D.from('0')), pnl = mine.reduce((n, f) => D.add(n, D.from(f.closedPnl ?? '0')), D.from('0'));
  log(`  fills of this run: ${mine.length}, fees ${D.str(fees)} USDC, closed PnL ${D.str(pnl)} USDC`);
  log(`  equity before ${before.equity} → after ${after.equity} (difference ${D.str(D.sub(D.from(after.equity), D.from(before.equity)))}; closed PnL − fees = ${D.str(D.sub(pnl, fees))}; funding, if any, explains the rest)`);
  check((await adapter.openOrders(account)).every((o) => !o.clientId || ![`${id}-rest`, `${id}-stop`, `${id}-tiny`].map(hlCloid).includes(o.clientId)), 'no order of this run is left open');
  const streamFills = events.filter((e) => e.type === 'fills').flatMap((e) => (e as unknown as { fills: { clientId: string | null }[] }).fills).filter((f) => [hlCloid(`${id}-buy`), hlCloid(`${id}-close`)].includes(f.clientId ?? ''));
  check(streamFills.length === mine.length, `the stream delivered the same ${mine.length} fill(s) as the REST history, each once`);
  log(`  stream events: ${Object.entries(events.reduce<Record<string, number>>((n, e) => { n[e.type] = (n[e.type] ?? 0) + 1; return n; }, {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  stop();
  log(`\ndone. The API wallet ${agent} existed only in this process; remove it in the testnet interface (API page) if you wish.`);
}

try { if (mode === 'proof') await proof(); else if (mode === 'full') await full(); else throw new Error('usage: hl-testnet.mts proof [--record] | full --account 0x…'); }
finally { adapter.close(); }
