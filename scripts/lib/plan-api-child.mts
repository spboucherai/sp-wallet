/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/lib/plan-api-child.mts
 * Module           : scripts
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

// The REAL API as its own process, for scripts/fork-plan.mts: real server (real swap/bridge providers and quotes), real
// worker steps (reconciliation, CCTP second leg, plan saga), real alerts dispatcher — against LOCAL anvil forks and a scratch
// database. The parent kills and restarts this process in the middle of a plan to prove that nothing lives in memory.
// Environment comes from the parent (SPW_*, DATABASE_URL, PORT). `--fresh` empties the scratch database first.
//
// Guard: a JSON-RPC call that would relay a signed transaction anywhere else than 127.0.0.1 is refused before it leaves.
import dns from 'node:dns';
import net from 'node:net';

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
const SEND = /"(eth_sendRawTransaction|eth_sendTransaction|sendTransaction|sendrawtransaction|broadcast_tx_(sync|async|commit)|submit)"/;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (typeof init?.body === 'string' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && SEND.test(init.body) && /"method"/.test(init.body)) throw new Error(`fork stack: refusing a transaction broadcast to ${u.host}`);
  return realFetch(input, init);
}) as typeof fetch;

const forked = Object.keys(JSON.parse(process.env.SPW_RPC_OVERRIDE ?? '{}') as Record<string, unknown>);
if (forked.length === 0 || !process.env.SPW_IRIS_OVERRIDE) throw new Error('this process only runs against local forks');
const warn = console.warn; console.warn = () => {};   // the two test-only override banners
const db = await import('../../services/api/src/db.ts');
if (process.argv.includes('--fresh')) await db.sql.unsafe('drop schema public cascade; create schema public;');
await db.migrate();
const { config } = await import('../../services/api/src/config.ts');
const app = await (await import('../../services/api/src/server.ts')).buildServer();   // default providers: real public quotes
const worker = await import('../../services/api/src/worker.ts');
const { advancePlans } = await import('../../services/api/src/plan-exec.ts');
const { adapterFor } = await import('../../services/api/src/chains/index.ts');
const { migrateAlerts } = await import('../../services/api/src/alerts/store.ts');
const { alerts } = await import('../../services/api/src/alerts/dispatcher.ts');
console.warn = warn;
for (const id of forked) worker.healthCache.set(id, await adapterFor(id).health());   // chain id and token metadata verified on the forks, as at start-up
await migrateAlerts();
const dispatcher = await alerts();
await app.listen({ port: config.port, host: '127.0.0.1' });
// what startWorkers() runs for transfers, swaps, bridges and plans — at a test pace, one pass at a time
let busy = false;
setInterval(() => { if (busy) return; busy = true;
  void (async () => {
    for (const [name, step] of [['expire', worker.expireStale], ['reconcile', worker.reconcile], ['bridges', worker.advanceBridges], ['plans', advancePlans], ['alerts', () => dispatcher.step()]] as const) {
      try { await step(); } catch (e) { console.log(`[child] ${name}: ${(e as Error).message.slice(0, 160)}`); } }
  })().finally(() => { busy = false; }); }, 1500);
console.log(`READY pid ${process.pid}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
