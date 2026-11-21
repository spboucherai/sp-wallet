/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/fork-swap-api.mts
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

// Full-stack swap test on a LOCAL FORK of Base: real API (HTTP layer, guards, KyberSwap, simulation), real signer process
// boundary (HMAC over HTTP), passkey approval, worker reconciliation — everything except the real network.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, numberToHex, parseUnits } from 'viem';
import { KYBER_ROUTER, NETWORKS } from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { dealTokenRpc } from './lib/fork-helpers.mts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const FORK = 'http://127.0.0.1:8548', ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'f'.repeat(48);
const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.evm;
const USDC = NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id, WHALE = process.env.USDC_WHALE ?? '0xF977814e90dA44bFA03b6295A0616a897441aceC';
let rid = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const bal = async (token: string) => token === 'native' ? hexToBigInt(await rpc<`0x${string}`>('eth_getBalance', [ME, 'latest'])) : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ME as `0x${string}`] }) }, 'latest']));
const anvil = spawn('anvil', ['--fork-url', process.env.BASE_RPC ?? 'https://mainnet.base.org', '--port', '8548', '--chain-id', '8453', '--silent'], { stdio: 'ignore' });
let signerSrv: Server | undefined, app: any, sql: any;
const cleanup = async () => { anvil.kill(); signerSrv?.close(); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); };
try {
  for (let k = 0; k < 80; k++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  await rpc('anvil_setBalance', [ME, numberToHex(parseUnits('1', 18))]);
  // 100 USDC for the test wallet, on the fork only. V11 final validation: written in the token's storage and read back (dealTokenRpc) —
  // the transfer from a fixed holder was unchecked and failed silently once that holder had no USDC left on Base (2026-11-17).
  // USDC_WHALE=<holder> keeps the old way, now checked.
  if (process.env.USDC_WHALE) { await rpc('anvil_impersonateAccount', [WHALE]); await rpc('anvil_setBalance', [WHALE, numberToHex(parseUnits('1', 18))]);
    await rpc('eth_sendTransaction', [{ from: WHALE, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ME as `0x${string}`, 100_000000n] }) }]);
    await rpc('anvil_stopImpersonatingAccount', [WHALE]); }
  else await dealTokenRpc(rpc as never, USDC, ME, 100_000000n, 'base');
  if ((await bal(USDC)) !== 100_000000n) throw new Error(`the test wallet holds ${await bal(USDC)} base units of USDC on the fork, 100000000 expected: the funding did not land`);

  const dir = mkdtempSync(join(tmpdir(), 'spw-forkapi-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('fork-setup').digest('hex');
  // anvil reports a 1 gwei priority fee (about a thousand times Base's real one): raise the fee ceiling for this fork only
  store.policy = { ...store.policy, maxFee: { ...store.policy.maxFee, base: '5000000000000000' } };
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: 'postgres:///spw_fork', SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_RPC_OVERRIDE: JSON.stringify({ base: [FORK, FORK] }) });
  const db = await import('../services/api/src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [] });
  const worker = await import('../services/api/src/worker.ts');
  await worker.refreshHealth(); // verifies chain id and token metadata on the fork, as at production start-up

  const pk = new TestPasskey(RP, ORIGIN); let cookie = '';
  const api = async (method: string, url: string, body?: unknown, idem?: string) => { const r = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined }; };
  const o = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: pk.register(o.options.challenge), setupToken: 'fork-setup' });
  if (s.status !== 200) throw new Error(`setup failed: ${JSON.stringify(s.json)}`);
  cookie = String(s.setCookie).split(';')[0]!;
  console.log(`fork of Base, wallet ${ME}: ${formatUnits(await bal('native'), 18)} ETH, ${formatUnits(await bal(USDC), 6)} USDC`);

  async function settle(id: string): Promise<any> {
    for (let k = 0; k < 120; k++) {
      await worker.reconcile(); await rpc('anvil_mine', [numberToHex(3)]);
      const p = (await api('GET', `/api/v1/transfers/proposals/${id}`)).json;
      if (['finalized', 'failed', 'replaced', 'expired'].includes(p.state)) return p;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('swap did not settle');
  }
  async function swap(label: string, fromAsset: string, toAsset: string, amount: string) {
    const before = { src: await bal(fromAsset), dst: await bal(toAsset) };
    const prep = await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset, toAsset, amount, slippageBps: 50 }, crypto.randomUUID());
    if (prep.status !== 200) throw new Error(`${label}: prepare failed ${prep.status} ${JSON.stringify(prep.json)}`);
    const p0 = prep.json.proposal;
    const ap = await api('POST', `/api/v1/transfers/proposals/${p0.id}/approve`, { assertion: pk.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    if (ap.status !== 200) throw new Error(`${label}: approve failed ${ap.status} ${JSON.stringify(ap.json)}`);
    const p = await settle(p0.id);
    const after = { src: await bal(fromAsset), dst: await bal(toAsset) };
    console.log(`${label}: ${p.state}; quoted ${p.swap.expectedOutDisplay}, approved minimum ${p.swap.minOutDisplay}, received per router event ${p.swap.receivedDisplay} ${p.swap.toSymbol}; approval ${p.swap.approvalState ?? 'not needed'}; simulated before approval: ${p.swap.simulated}`);
    if (p.state !== 'finalized') throw new Error(`${label}: ended ${p.state}: ${p.error}`);
    if (p.swap.received === null || BigInt(p.swap.received) < BigInt(p.swap.minOut)) throw new Error(`${label}: received below the approved minimum`);
    if (toAsset !== 'native' && after.dst - before.dst !== BigInt(p.swap.received)) throw new Error(`${label}: balance change ${after.dst - before.dst} differs from the recorded outcome`);
    if (fromAsset !== 'native' && before.src - after.src !== BigInt(p.amount)) throw new Error(`${label}: spent ${before.src - after.src}, approved ${p.amount}`);
    return p;
  }
  await swap('ETH  -> USDC', 'native', USDC, '0.01');
  await swap('USDC -> ETH ', USDC, 'native', '25');   // token input: exact approval mined first, swap simulated again, then sent
  const allowance = hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME as `0x${string}`, KYBER_ROUTER as `0x${string}`] }) }, 'latest']));
  if (allowance !== 0n) throw new Error('an allowance was left behind'); console.log('leftover allowance: 0');

  // a compromised API/database swaps the calldata after the owner approved: the signer must refuse
  const prep = await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.005', slippageBps: 50 }, crypto.randomUUID());
  const evil = (await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.005', slippageBps: 50 }, crypto.randomUUID()));
  console.log('second swap while one is pending approval:', evil.status, evil.json.error ?? 'prepared');
  await sql`update proposals set aux = jsonb_set(aux, '{swapData}', to_jsonb(overlay(aux->>'swapData' placing 'ff' from length(aux->>'swapData') - 1))) where id = ${prep.json.proposal.id}`;
  const bad = await api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: pk.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
  console.log('tampered calldata after approval:', bad.status, bad.json.message);
  if (bad.status === 200) throw new Error('signer accepted tampered calldata');
  const audit = (await api('GET', '/api/v1/security/audit?limit=200')).json;
  console.log(`audit chain intact: ${audit.intact}; swap events: ${audit.events.filter((e: any) => e.type.startsWith('swap.')).map((e: any) => e.type).join(', ')}`);
  console.log('\nFULL-STACK FORK TEST OK — nothing was sent to the real network');
} finally { await cleanup(); }
process.exit(0);
