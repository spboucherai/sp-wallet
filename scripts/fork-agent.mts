// The whole life of a trading agent on a LOCAL FORK of Base (anvil): real API, real signer process boundary with its own
// exchange prices, real market data and laboratory, real KyberSwap routes — only the chain is a fork. Nothing reaches mainnet.
// create agent → register + backtest a strategy → approve → paper trading → fund vault → mandate (passkey) → live orders
// through the engine → signer refusals → revoke → withdraw to the owner.
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, numberToHex, parseUnits } from 'viem';
import { NETWORKS } from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../services/isolated-signer/src/prices.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const FORK = 'http://127.0.0.1:8549', ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'f'.repeat(48), DB = 'spw_fork_agent';
const SRC_DB = process.env.CANDLES_DB ?? 'spw_market_dev'; // a database already holding backfilled candles
const keys = deriveKeys(generateMnemonic(wordlist, 128)), OWNER = keys.addresses.evm;
const USDC = NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id, WHALE = process.env.USDC_WHALE ?? '0xF977814e90dA44bFA03b6295A0616a897441aceC';
const STRAT = join(import.meta.dirname, '../research/strategies/zz_forktest');
let rid = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const bal = async (who: string, token: string) => token === 'native' ? hexToBigInt(await rpc<`0x${string}`>('eth_getBalance', [who, 'latest'])) : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who as `0x${string}`] }) }, 'latest']));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anvil = spawn('anvil', ['--fork-url', process.env.BASE_RPC ?? 'https://mainnet.base.org', '--port', '8549', '--chain-id', '8453', '--silent'], { stdio: 'ignore' });
let signerSrv: Server | undefined, app: any, sql: any;
const cleanup = async () => { anvil.kill(); signerSrv?.close(); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); rmSync(STRAT, { recursive: true, force: true }); };
const weights = (w: Record<string, number>) => { mkdirSync(join(STRAT, '1'), { recursive: true }); writeFileSync(join(STRAT, '1', 'strategy.py'),
  `"""Fork-test strategy: constant target weights. Not a trading rule."""\nMETA = {\n    "name": "zz_forktest",\n    "version": "1",\n    "universe": ["ETH", "LINK", "AAVE"],\n    "interval": "1h",\n    "lookback": 300,\n    "params": {"eth": ${w.ETH}, "link": ${w.LINK}},\n}\n\n\ndef target_weights(data, params):\n    return {"ETH": float(params["eth"]), "LINK": float(params["link"]), "AAVE": 0.0}\n`); };
try {
  for (let k = 0; k < 80; k++) { try { await rpc('eth_chainId'); break; } catch { await sleep(250); } }
  execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);
  const dir = mkdtempSync(join(tmpdir(), 'spw-forkagent-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('fork-setup').digest('hex');
  store.policy = { ...store.policy, maxFee: { ...store.policy.maxFee, base: '5000000000000000' } }; // anvil's 1 gwei tip, fork only
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, exchangePrices()), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_RPC_OVERRIDE: JSON.stringify({ base: [FORK, FORK] }) });
  const db = await import('../services/api/src/db.ts'); sql = db.sql; await db.migrate();
  execSync(`psql -q ${SRC_DB} -c "copy (select * from candles where symbol in ('ETH','LINK','AAVE') and interval = '1h') to stdout" | psql -q ${DB} -c "copy candles from stdin"`);
  const market = await import('../services/api/src/market/index.ts'), pipe = await import('../services/api/src/market/pipeline.ts'), sources = await import('../services/api/src/market/sources.ts');
  const up = await pipe.updateAll(sources.defaultSources(), { ...pipe.marketConfig(), symbols: ['ETH', 'LINK', 'AAVE'], intervals: ['1h'] } as never);
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

  // 1. agent, strategy, backtest, approval
  const ag = await ok('POST', '/api/v1/agents', { name: 'Fork agent', universe: ['ETH', 'LINK', 'AAVE'], interval: '1h', capitalUsdc: '60', risk: { maxExposurePct: 80, maxLossPct: 5, maxOrderUsd: 20, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 100 } });
  const VAULT = ag.vaultAddress as string, id = ag.id as string;
  console.log(`agent ${id}, vault ${VAULT} (owner wallet ${OWNER})`);
  if (VAULT.toLowerCase() === OWNER.toLowerCase()) throw new Error('vault is the owner address');
  const libNames = (await ok('GET', '/api/v1/strategies')).strategies.map((x: any) => `${x.meta.name}/${x.meta.version}`);
  console.log(`library: ${libNames.length} loadable versions`);
  const bad = await api('POST', `/api/v1/agents/${id}/strategies`, { path: 'ts_momentum/1' });
  console.log('strategy for another universe:', bad.status, bad.json?.error);
  if (bad.status === 200) throw new Error('a strategy for another universe was accepted');
  weights({ ETH: 0.5, LINK: 0.25 });
  const reg = await ok('POST', `/api/v1/agents/${id}/strategies`, { path: 'zz_forktest/1' });
  const early = await api('POST', `/api/v1/agents/${id}/strategies/${reg.id}/approve`);
  let ver: any; for (let k = 0; k < 200; k++) { ver = (await ok('GET', `/api/v1/agents/${id}`)).versions.find((v: any) => v.id === reg.id); if (ver.metrics || (ver.status === 'draft' && ver.notes)) break; await sleep(1000); }
  if (!ver.metrics) throw new Error(`backtest did not produce a report: ${ver.notes}`);
  console.log(`approval before the report: ${early.status} ${early.json?.error ?? ''}; backtest attached: test return ${(100 * ver.metrics.test.total_return).toFixed(1)} %, ${ver.metrics.test.trades} trades`);
  await ok('POST', `/api/v1/agents/${id}/strategies/${reg.id}/approve`);

  // 2. paper trading: real data, real signal process, real quotes, nothing signed
  await ok('POST', `/api/v1/agents/${id}/mode`, { mode: 'PAPER' });
  console.log('paper pass:', Object.values(await live.enginePass(mkt))[0]);
  let d = await ok('GET', `/api/v1/agents/${id}`);
  for (const x of d.orders) console.log(`  PAPER ${x.from_symbol} → ${x.to_symbol}: in ${x.amount_in}, filled ${x.received} (${x.state})`);
  if (!d.orders.length || d.orders.some((x: any) => x.mode !== 'PAPER' || x.txid)) throw new Error('paper trading did not produce paper-only orders');
  if ((await bal(VAULT, USDC)) !== 0n) throw new Error('paper trading touched the vault');
  console.log('second paper pass (same bar):', Object.values(await live.enginePass(mkt))[0]);

  // 3. fund the vault on the fork, approve the mandate with the passkey
  await rpc('anvil_setBalance', [VAULT, numberToHex(parseUnits('0.02', 18))]);
  await rpc('anvil_impersonateAccount', [WHALE]); await rpc('anvil_setBalance', [WHALE, numberToHex(parseUnits('1', 18))]);
  await rpc('eth_sendTransaction', [{ from: WHALE, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [VAULT as `0x${string}`, 60_000000n] }) }]);
  await rpc('anvil_stopImpersonatingAccount', [WHALE]);
  const prep = await ok('POST', `/api/v1/agents/${id}/mandate/prepare`);
  console.log('mandate limits:', prep.limits.map((l: any) => `${l.symbol} ≤ ${l.maxOrder}/order, ${l.maxDaily}/day`).join('; '), `— max slippage ${prep.mandate.maxSlippageBps} bps, ${prep.mandate.maxOrdersPerDay} orders/day`);
  const wrong = await api('POST', `/api/v1/agents/${id}/mandate/approve`, { assertion: pk.assert(new Uint8Array(32)) });
  console.log('mandate with a passkey signature over something else:', wrong.status, wrong.json?.error);
  if (wrong.status === 200) throw new Error('mandate approved without a valid passkey assertion');
  await ok('POST', `/api/v1/agents/${id}/mandate/approve`, { assertion: pk.assert(Buffer.from(prep.options.challenge, 'base64url')) });

  // 4. live: the engine places one order at a time; each is signed under the mandate, mined on the fork, read back
  await sql`update agents set last_bar = null where id = ${id}`; // the paper run already handled this bar
  let filled = 0;
  for (let k = 0; k < 90 && filled < 2; k++) {
    const res = Object.values(await live.enginePass(mkt))[0]; await rpc('anvil_mine', [numberToHex(2)]);
    const rows = await sql`select state, from_symbol, to_symbol, amount_in, min_out, received, reason from agent_orders where agent_id = ${id} and mode = 'LIVE' order by ts`;
    const f = rows.filter((r: any) => r.state === 'filled').length;
    if (f !== filled) { filled = f; const r = rows[f - 1]; console.log(`  LIVE ${r.from_symbol} → ${r.to_symbol}: in ${r.amount_in}, minimum ${r.min_out}, received ${r.received} (engine: ${res})`); if (BigInt(r.received) < BigInt(r.min_out)) throw new Error('received below the signed minimum'); }
    const failed = rows.find((r: any) => r.state === 'failed'); if (failed) throw new Error(`live order failed: ${failed.reason}`);
    if (String(res).startsWith('error')) throw new Error(`engine: ${res}`);
    await sleep(1300);
  }
  if (filled < 2) throw new Error('the engine did not fill two live orders');
  d = await ok('GET', `/api/v1/agents/${id}`);
  console.log('vault now:', d.vault.map((x: any) => `${x.display} ${x.symbol}`).join(', '), '| signer usage today:', JSON.stringify(d.mandateStatus.today));
  if ((await bal(OWNER, USDC)) !== 0n) throw new Error('the owner wallet moved');

  // 5. what the signer refuses even when the engine asks: an order above the mandate, then anything once revoked
  const core = await import('@spw/core'), sx = await import('../services/api/src/swap-exec.ts'), sc = await import('../services/api/src/signer-client.ts');
  const st = await sc.signer.status(true), agentRow = (await sql`select * from agents where id = ${id}`)[0];
  const tryOrder = async (what: string, amount: bigint) => { const ps = await sx.prepareKyberSwap({ n: core.getNetwork('base'), me: VAULT, keyId: core.vaultKeyId(st.keyId, agentRow.vault_index), fromAsset: USDC, toAsset: 'native', amount, slippageBps: 100, policyVersion: st.policy.version, proposalId: crypto.randomUUID(), ttlSec: 120 });
    try { await sc.signer.mandateSign(agentRow.mandate_id, ps.intent, { swapData: ps.data }); } catch (e) { console.log(`refused by the signer (${what}): ${(e as Error).message.slice(0, 110)}`); return; } throw new Error(`signer accepted: ${what}`); };
  await sleep(1300); await tryOrder('order above the per-order limit', 25_000000n);
  await ok('POST', `/api/v1/agents/${id}/revoke`);
  await sleep(1300); await tryOrder('order after revocation', 5_000000n);
  console.log('engine after revocation:', JSON.stringify(await live.enginePass(mkt)));

  // 6. withdraw: a vault can only pay the owner
  const before = await bal(OWNER, USDC), vaultUsdc = await bal(VAULT, USDC);
  const w = await ok('POST', `/api/v1/agents/${id}/withdraw`, { asset: USDC }); await rpc('anvil_mine', [numberToHex(2)]);
  const got = (await bal(OWNER, USDC)) - before;
  console.log(`withdraw: ${w.amount} ${w.symbol} → owner received ${formatUnits(got, 6)} USDC, vault keeps ${formatUnits(await bal(VAULT, USDC), 6)}`);
  if (got !== vaultUsdc || got === 0n) throw new Error('withdrawal did not reach the owner in full');
  const audit = await ok('GET', '/api/v1/security/audit?limit=300');
  console.log(`audit chain intact: ${audit.intact}; agent events: ${[...new Set(audit.events.map((e: any) => e.type).filter((t: string) => /agent|mandate|strategy/.test(t)))].join(', ')}`);
  console.log('\nAGENT FORK TEST OK — nothing was sent to the real network');
} finally { await cleanup(); }
process.exit(0);
