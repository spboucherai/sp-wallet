/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/fork-agent.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-17
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

// The whole life of a trading agent on a LOCAL FORK (anvil) of any execution-enabled EVM network: real API, real signer
// process boundary with its own exchange prices, real market data and laboratory, real KyberSwap routes — only the chain
// is a fork. Nothing reaches mainnet.
// create agent → register + backtest a strategy → approve → paper trading → fund vault → mandate (passkey) → live orders
// through the engine → signer refusals → revoke → withdraw to the owner.
//
//   NETWORK=<id>            network to fork (default base); any network of KYBER_ENABLED with a cash leg in the registry
//   UNIVERSE=<comma list>   market symbols the agent trades (default ETH,LINK,AAVE); taken as they are from the registry
//   FORK_RPC=<url>          upstream node (default: the registry's first endpoint; BASE_RPC is still read for Base)
//   USDC_WHALE=<address>    an account holding the cash asset on that network (default: a few known holders are tried)
//   CANDLES_DB, FORK_DB, FORK_PORT   database holding backfilled candles, scratch database, anvil port
// Symbols the signer cannot price (not on Coinbase AND Kraken) are paper traded only: the script shows the refusal, then
// runs the live part with a second agent restricted to the symbols that can go live.
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, numberToHex, parseUnits } from 'viem';
import { cashLegs, getNetwork, hasSignerPrice, KYBER_ENABLED, tradableSymbols } from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { dealTokenRpc } from './lib/fork-helpers.mts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../services/isolated-signer/src/prices.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const NETWORK = process.env.NETWORK ?? 'base', UNIVERSE = (process.env.UNIVERSE ?? 'ETH,LINK,AAVE').split(',').map((s) => s.trim()).filter(Boolean);
if (!KYBER_ENABLED[NETWORK]) throw new Error(`NETWORK=${NETWORK}: swap execution is not enabled there (choose one of ${Object.keys(KYBER_ENABLED).join(', ')})`);
const NET = getNetwork(NETWORK), CASH = cashLegs(NET)[0];
if (!CASH) throw new Error(`${NET.name}: no cash leg (USDC, USDT) in the wallet registry yet`);
const PORT = Number(process.env.FORK_PORT ?? 8549), FORK = `http://127.0.0.1:${PORT}`, ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'f'.repeat(48), DB = process.env.FORK_DB ?? 'spw_fork_agent';
const SRC_DB = process.env.CANDLES_DB ?? 'spw_market_dev'; // a database already holding backfilled candles
if (!/^[a-z0-9_]+$/.test(DB) || !/^[a-z0-9_]+$/.test(SRC_DB) || !UNIVERSE.every((s) => /^[A-Z0-9]{2,10}$/.test(s))) throw new Error('bad database name or symbol');
const UPSTREAM = process.env.FORK_RPC ?? (NETWORK === 'base' ? process.env.BASE_RPC ?? 'https://mainnet.base.org' : NET.rpc[0]!);
const keys = deriveKeys(generateMnemonic(wordlist, 128)), OWNER = keys.addresses.evm; // a fresh random wallet at every run
const USDC = CASH.id;
// accounts known to hold the cash asset (exchange hot wallets, lending pools): the first with enough of it is impersonated on the fork
const WHALES = [process.env.USDC_WHALE, '0xF977814e90dA44bFA03b6295A0616a897441aceC', '0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D', '0x28C6c06298d514Db089934071355E5743bf21d60', '0x724dc807b04555b71ed48a6896b6F41593b8C637', '0x625E7708f30cA75bfd92586e17077590C60eb4cD', '0x47c031236e19d024b42f8AE6780E44A573170703'].filter((x): x is string => !!x);
const STRAT = join(import.meta.dirname, '../research/strategies/zz_forktest');
let rid = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const bal = async (who: string, token: string) => token === 'native' ? hexToBigInt(await rpc<`0x${string}`>('eth_getBalance', [who, 'latest'])) : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who as `0x${string}`] }) }, 'latest']));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anvil = spawn('anvil', ['--fork-url', UPSTREAM, '--port', String(PORT), '--chain-id', NET.chainRef, '--silent'], { stdio: 'ignore' });
let signerSrv: Server | undefined, app: any, sql: any;
const cleanup = async () => { anvil.kill(); signerSrv?.close(); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); rmSync(STRAT, { recursive: true, force: true }); };
// The fork-test strategy is universe-generic (META["universe"] == ["*"]): the same constant allocation whatever symbols
// the agent trades. Not a trading rule.
const writeStrategy = (total: number) => { mkdirSync(join(STRAT, '1'), { recursive: true }); writeFileSync(join(STRAT, '1', 'strategy.py'),
  `"""Fork-test strategy: constant target weights, equal across whatever symbols the agent trades. Not a trading rule."""\nMETA = {\n    "name": "zz_forktest",\n    "version": "1",\n    "universe": ["*"],\n    "interval": "1h",\n    "lookback": 300,\n    "params": {"total": ${total}},\n}\n\n\ndef target_weights(data, params):\n    return {symbol: float(params["total"]) / len(data) for symbol in data}\n`); };
try {
  for (let k = 0; k < 120; k++) { try { await rpc('eth_chainId'); break; } catch { await sleep(250); } }
  if (Number(await rpc<string>('eth_chainId')) !== Number(NET.chainRef)) throw new Error('the fork did not start');
  console.log(`fork of ${NET.name} (chain ${NET.chainRef}) at block ${Number(await rpc<string>('eth_blockNumber'))}; universe ${UNIVERSE.join(', ')}; cash ${CASH.symbol}`);
  execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);
  const dir = mkdtempSync(join(tmpdir(), 'spw-forkagent-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('fork-setup').digest('hex');
  if (BigInt(store.policy.maxFee[NETWORK] ?? '0') < 5_000_000_000_000_000n) store.policy = { ...store.policy, maxFee: { ...store.policy.maxFee, [NETWORK]: '5000000000000000' } }; // anvil's 1 gwei tip, fork only
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, exchangePrices()), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_RPC_OVERRIDE: JSON.stringify({ [NETWORK]: [FORK, FORK] }) });
  const db = await import('../services/api/src/db.ts'); sql = db.sql; await db.migrate();
  execSync(`psql -q ${SRC_DB} -c "copy (select * from candles where symbol in (${UNIVERSE.map((s) => `'${s}'`).join(',')}) and interval = '1h') to stdout" | psql -q ${DB} -c "copy candles from stdin"`);
  const market = await import('../services/api/src/market/index.ts'), pipe = await import('../services/api/src/market/pipeline.ts'), sources = await import('../services/api/src/market/sources.ts');
  const up = await pipe.updateAll(sources.defaultSources(), { ...pipe.marketConfig(), symbols: UNIVERSE, intervals: ['1h'], only: {}, first: [] });
  console.log(`market data: ${(await sql`select count(*)::int as n from candles`)[0].n} stored bars, ${up.written} fetched now${up.errors.length ? `, errors: ${up.errors.join('; ').slice(0, 200)}` : ''}`);
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [] });
  await (await import('../services/api/src/worker.ts')).refreshHealth();
  const live = await import('../services/api/src/agents/live.ts');
  const mkt = { series: async (s: string, i: string, limit: number) => (await market.getSeries(s as never, i as never, { limit })).bars, assertFresh: async (s: string, i: string) => { await market.assertFresh(s as never, i as never); } };

  const pk = new TestPasskey(RP, ORIGIN); let cookie = '';
  const api = async (method: string, url: string, body?: unknown) => { const r = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}) }, ...(method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined }; };
  const ok = async (method: string, url: string, body?: unknown) => { const r = await api(method, url, body); if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const o = await ok('POST', '/api/v1/auth/setup/options', {});
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: pk.register(o.options.challenge), setupToken: 'fork-setup' });
  if (s.status !== 200) throw new Error(`setup failed: ${JSON.stringify(s.json)}`);
  cookie = String(s.setCookie).split(';')[0]!;

  // 0. what the registry makes tradable here, as the UI sees it
  const nets = await ok('GET', '/api/v1/agents/networks'), here = nets.networks.find((n: any) => n.id === NETWORK);
  console.log(`tradable on ${here.name} today (${here.symbols.length} symbols, derived from the registry): ${here.symbols.map((x: any) => `${x.symbol}${x.representations.length > 1 ? `[${x.representations.map((r: any) => r.assetSymbol).join('|')}]` : x.representations[0].assetSymbol !== x.symbol ? `[${x.representations[0].assetSymbol}]` : ''}${x.live ? '' : ' (paper only)'}`).join(', ')}`);
  console.log(`gas on the fork: ${here.gas?.gasPriceGwei} gwei → ${here.gas?.perOrder} ${here.native} per order, reserve to go live ${here.gas?.reserve} ${here.native}`);
  for (const sym of UNIVERSE) if (!tradableSymbols(NET).some((t) => t.symbol === sym)) throw new Error(`${sym} is not tradable on ${NET.name} with today's registry`);

  // 1. agent, strategy, backtest, approval
  const RISK = { maxExposurePct: 80, maxLossPct: 5, maxOrderUsd: 20, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 100 };
  writeStrategy(0.45); // 45 % invested, equal across the universe: the vault keeps enough cash for the over-limit attempt of step 5
  const prepareAgent = async (name: string, universe: string[]) => {
    const ag = await ok('POST', '/api/v1/agents', { name, network: NETWORK, universe, interval: '1h', capitalUsdc: '60', risk: RISK });
    console.log(`agent "${name}" ${ag.id} on ${ag.networkName}, vault ${ag.vaultAddress} (index ${ag.vaultIndex}; owner wallet ${OWNER})`);
    console.log(`  holds: ${ag.holdings.map((h: any) => `${h.symbol} as ${h.assetSymbol}${h.issuer ? ` (issuer: ${h.issuer})` : ''}`).join('; ')}`);
    for (const w of ag.warnings) console.log(`  warning [${w.code}]: ${w.message}`);
    if (String(ag.vaultAddress).toLowerCase() === OWNER.toLowerCase()) throw new Error('vault is the owner address');
    const reg = await ok('POST', `/api/v1/agents/${ag.id}/strategies`, { path: 'zz_forktest/1' });
    const early = await api('POST', `/api/v1/agents/${ag.id}/strategies/${reg.id}/approve`);
    let ver: any; for (let k = 0; k < 300; k++) { ver = (await ok('GET', `/api/v1/agents/${ag.id}`)).versions.find((v: any) => v.id === reg.id); if (ver.metrics || (ver.status === 'draft' && ver.notes)) break; await sleep(1000); }
    if (!ver.metrics) throw new Error(`backtest did not produce a report: ${ver.notes}`);
    console.log(`  generic strategy registered for ${reg.symbols.join(', ')}; approval before the report: ${early.status} ${early.json?.error ?? ''}; backtest attached on symbols ${ver.config.symbols.join(', ')} (${ver.config.start?.slice(0, 10)} → ${ver.config.end?.slice(0, 10)}): test return ${(100 * ver.metrics.test.total_return).toFixed(1)} %, ${ver.metrics.test.trades} trades`);
    if ([...ver.config.symbols].sort().join() !== [...universe].sort().join()) throw new Error('the report is not about the agent\'s symbols');
    await ok('POST', `/api/v1/agents/${ag.id}/strategies/${reg.id}/approve`);
    return ag;
  };
  const lib = (await ok('GET', '/api/v1/strategies')).strategies;
  console.log(`library: ${lib.length} loadable versions, ${lib.filter((x: any) => x.generic).length} universe-generic (${lib.filter((x: any) => x.generic).map((x: any) => `${x.meta.name}/${x.meta.version}`).join(', ')})`);
  const ag = await prepareAgent('Fork agent', UNIVERSE);
  let id = ag.id as string, VAULT = ag.vaultAddress as string;
  const bad = await api('POST', `/api/v1/agents/${id}/strategies`, { path: 'pairs_rotation/1' });
  console.log('fixed-universe strategy written for other symbols:', bad.status, bad.json?.error);
  if (bad.status === 200) throw new Error('a strategy for another universe was accepted');
  if (UNIVERSE.length < 3) { const xs = await api('POST', `/api/v1/agents/${id}/strategies`, { path: 'xs_momentum/3' }); console.log('cross-sectional momentum with fewer than 3 symbols:', xs.status, xs.json?.error); if (xs.status === 200) throw new Error('xs_momentum accepted below 3 symbols'); }

  // 2. paper trading: real data, real signal process, real quotes on this network, nothing signed
  await ok('POST', `/api/v1/agents/${id}/mode`, { mode: 'PAPER' });
  console.log('paper pass:', Object.values(await live.enginePass(mkt))[0]);
  let d = await ok('GET', `/api/v1/agents/${id}`);
  for (const x of d.orders) console.log(`  PAPER ${x.from_symbol} → ${x.to_symbol}: in ${x.amount_in}, filled ${x.received} (${x.state})`);
  if (!d.orders.length || d.orders.some((x: any) => x.mode !== 'PAPER' || x.txid)) throw new Error('paper trading did not produce paper-only orders');
  if (new Set(d.orders.map((x: any) => x.to_symbol)).size !== UNIVERSE.length) throw new Error(`paper trading did not reach every symbol of the universe (${[...new Set(d.orders.map((x: any) => x.to_symbol))].join(', ')})`);
  if ((await bal(VAULT, USDC)) !== 0n) throw new Error('paper trading touched the vault');
  console.log('second paper pass (same bar):', Object.values(await live.enginePass(mkt))[0]);

  // 2b. symbols the signer cannot price are paper only: the mandate is refused; the live part uses the others
  const liveUniverse = UNIVERSE.filter((x) => hasSignerPrice(x));
  if (liveUniverse.length !== UNIVERSE.length) {
    const no = await api('POST', `/api/v1/agents/${id}/mandate/prepare`);
    console.log(`mandate for a universe the signer cannot fully price: ${no.status} ${no.json?.error} — ${String(no.json?.message).slice(0, 150)}`);
    if (no.status === 200) throw new Error('a mandate was prepared for a symbol without a signer price');
    await ok('POST', `/api/v1/agents/${id}/mode`, { mode: 'STOPPED' });
    const second = await prepareAgent('Fork agent (live)', liveUniverse);
    if (second.vaultIndex === ag.vaultIndex || second.vaultAddress === VAULT) throw new Error('two agents share a vault');
    id = second.id; VAULT = second.vaultAddress;
  }

  // 3. the gas reserve gate, then fund the vault on the fork and approve the mandate with the passkey
  const dry = await api('POST', `/api/v1/agents/${id}/mandate/prepare`);
  console.log(`mandate before the vault holds the gas reserve: ${dry.status} ${dry.json?.error} — ${String(dry.json?.message).slice(0, 160)}`);
  if (dry.status !== 409 || dry.json?.error !== 'insufficient_gas') throw new Error('live trading could be prepared without the gas reserve');
  await rpc('anvil_setBalance', [VAULT, numberToHex(parseUnits('0.02', 18))]);
  const need = 60n * 10n ** BigInt(CASH.decimals);
  let funded = false;
  for (const w of WHALES) { // the first known holder whose transfer really lands on the fork
    if ((await bal(w, USDC)) < need) continue;
    await rpc('anvil_impersonateAccount', [w]); await rpc('anvil_setBalance', [w, numberToHex(parseUnits('1', 18))]);
    try { await rpc('eth_sendTransaction', [{ from: w, to: USDC, gas: numberToHex(300_000), data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [VAULT as `0x${string}`, need] }) }]); await rpc('anvil_mine', [numberToHex(1)]); } catch { /* next holder */ }
    await rpc('anvil_stopImpersonatingAccount', [w]);
    if ((await bal(VAULT, USDC)) === need) { funded = true; break; }
  }
  // V11 final validation: on 2026-11-17 none of the known holders could fund the vault on Base (their balances moved). The balance is
  // then written in the token's storage and read back (scripts/lib/fork-helpers.mts) — a fork-only write that needs no third party.
  if (!funded) { await dealTokenRpc(rpc as never, USDC, VAULT, need, NET.name); funded = (await bal(VAULT, USDC)) === need; }
  if (!funded) throw new Error(`the vault could not be given ${CASH.symbol} on the ${NET.name} fork (no known holder, and the balance slot was not found): set USDC_WHALE`);
  const prep = await ok('POST', `/api/v1/agents/${id}/mandate/prepare`);
  console.log(`mandate on ${prep.networkName} (network ${prep.mandate.network}, vault index ${prep.mandate.vaultIndex}), gas reserve ${prep.gasReserve.required} ${prep.gasReserve.symbol} (held ${prep.gasReserve.held}):`);
  console.log('  limits:', prep.limits.map((l: any) => `${l.symbol} ≤ ${l.maxOrder}/order, ${l.maxDaily}/day`).join('; '), `— max slippage ${prep.mandate.maxSlippageBps} bps, ${prep.mandate.maxOrdersPerDay} orders/day`);
  if (prep.mandate.network !== NETWORK) throw new Error('mandate for another network');
  const wrong = await api('POST', `/api/v1/agents/${id}/mandate/approve`, { assertion: pk.assert(new Uint8Array(32)) });
  console.log('mandate with a passkey signature over something else:', wrong.status, wrong.json?.error);
  if (wrong.status === 200) throw new Error('mandate approved without a valid passkey assertion');
  await ok('POST', `/api/v1/agents/${id}/mandate/approve`, { assertion: pk.assert(Buffer.from(prep.options.challenge, 'base64url')) });

  // 4. live: the engine places one order at a time; each is signed under the mandate, mined on the fork, read back
  await sql`update agents set last_bar = null where id = ${id}`; // start from a clean bar
  let filled = 0;
  for (let k = 0; k < 90 && filled < 2; k++) {
    const res = Object.values(await live.enginePass(mkt)).at(-1); await rpc('anvil_mine', [numberToHex(2)]);
    const rows = await sql`select state, from_symbol, to_symbol, amount_in, min_out, received, reason, intent from agent_orders where agent_id = ${id} and mode = 'LIVE' order by ts`;
    const f = rows.filter((r: any) => r.state === 'filled').length;
    if (f !== filled) { filled = f; const r = rows[f - 1]; console.log(`  LIVE ${r.from_symbol} → ${r.to_symbol}: in ${r.amount_in}, minimum ${r.min_out}, received ${r.received}, chain ${r.intent.chainRef} (engine: ${res})`); if (BigInt(r.received) < BigInt(r.min_out)) throw new Error('received below the signed minimum'); if (r.intent.chainRef !== NET.chainRef) throw new Error('order for another chain'); }
    const failed = rows.find((r: any) => r.state === 'failed'); if (failed) throw new Error(`live order failed: ${failed.reason}`);
    if (String(res).startsWith('error')) throw new Error(`engine: ${res}`);
    await sleep(1300);
  }
  if (filled < 2) throw new Error('the engine did not fill two live orders');
  d = await ok('GET', `/api/v1/agents/${id}`);
  console.log('vault now:', d.vault.map((x: any) => `${x.display} ${x.assetSymbol}${x.role === 'gas' ? ' (gas)' : ''}`).join(', '), '| signer usage today:', JSON.stringify(d.mandateStatus.today));
  if ((await bal(OWNER, USDC)) !== 0n) throw new Error('the owner wallet moved');

  // 5. what the signer refuses even when the engine asks: an order above the mandate, then anything once revoked
  const core = await import('@spw/core'), sx = await import('../services/api/src/swap-exec.ts'), sc = await import('../services/api/src/signer-client.ts');
  const st = await sc.signer.status(true), agentRow = (await sql`select * from agents where id = ${id}`)[0];
  const target = d.holdings.find((h: any) => h.kind !== 'cash').asset as string;
  const tryOrder = async (what: string, amount: bigint) => { const ps = await sx.prepareKyberSwap({ n: core.getNetwork(NETWORK), me: VAULT, keyId: core.vaultKeyId(st.keyId, agentRow.vault_index), fromAsset: USDC, toAsset: target, amount, slippageBps: 100, policyVersion: st.policy.version, proposalId: crypto.randomUUID(), ttlSec: 120 });
    try { await sc.signer.mandateSign(agentRow.mandate_id, ps.intent, { swapData: ps.data }); } catch (e) { console.log(`refused by the signer (${what}): ${(e as Error).message.slice(0, 110)}`); return; } throw new Error(`signer accepted: ${what}`); };
  const unit = 10n ** BigInt(CASH.decimals);
  await sleep(1300); await tryOrder('order above the per-order limit', 25n * unit);
  await ok('POST', `/api/v1/agents/${id}/revoke`);
  await sleep(1300); await tryOrder('order after revocation', 5n * unit);
  console.log('engine after revocation:', JSON.stringify(Object.values(await live.enginePass(mkt))));

  // 6. withdraw: a vault can only pay the owner
  const before = await bal(OWNER, USDC), vaultUsdc = await bal(VAULT, USDC);
  const w = await ok('POST', `/api/v1/agents/${id}/withdraw`, { asset: USDC }); await rpc('anvil_mine', [numberToHex(2)]);
  const got = (await bal(OWNER, USDC)) - before;
  console.log(`withdraw: ${w.amount} ${w.symbol} → owner received ${formatUnits(got, CASH.decimals)} ${CASH.symbol}, vault keeps ${formatUnits(await bal(VAULT, USDC), CASH.decimals)}`);
  if (got !== vaultUsdc || got === 0n) throw new Error('withdrawal did not reach the owner in full');
  const audit = await ok('GET', '/api/v1/security/audit?limit=300');
  console.log(`audit chain intact: ${audit.intact}; agent events: ${[...new Set(audit.events.map((e: any) => e.type).filter((t: string) => /agent|mandate|strategy/.test(t)))].join(', ')}`);
  console.log(`\nAGENT FORK TEST OK on ${NET.name} with ${UNIVERSE.join(', ')} — nothing was sent to the real network`);
} finally { await cleanup(); }
process.exit(0);
